// Generates workbook-portfolio.json (an ARM template) from the workbook definition below.
//
// Why a generator? An Azure Workbook ARM template carries the entire workbook as a JSON
// *string* inside properties.serializedData. Hand-escaping that is miserable and a single
// stray quote produces a deployment error with no useful line number. Here the workbook is
// authored as a normal object and the escaping is done by JSON.stringify.
//
//   node build-workbook.mjs
//
// The '__WORKSPACE_ID__' token is substituted at deploy time by an ARM replace(), using the
// workspace resource id that deploy.sh passes as the workbookSourceId parameter. That keeps
// the template portable across subscriptions.

import { writeFileSync, readFileSync } from "node:fs";

const WS = "__WORKSPACE_ID__";

// The estate map query lives in queries/estate-map.kql so it can be run and iterated on
// directly in the Logs blade. Read it here rather than duplicating it.
const estateMapQuery = readFileSync(new URL("./queries/estate-map.kql", import.meta.url), "utf8");

const catalogTable = `let catalog = datatable(workload: string, displayName: string, domain: string, criticality: string, owner: string, businessOwner: string, appUrl: string, docsUrl: string, runbookUrl: string, repoUrl: string, slo: real)
[
    "retail-web", "Retail Storefront", "Retail", "tier1", "commerce-team", "VP Digital Commerce", "https://shop.contoso-demo.example", "https://wiki.contoso-demo.example/retail/storefront", "https://runbooks.contoso-demo.example/retail-web", "https://github.com/contoso-demo/retail-web", 99.9,
    "retail-api-orders", "Order Management API", "Retail", "tier1", "commerce-team", "VP Digital Commerce", "https://api.contoso-demo.example/orders", "https://wiki.contoso-demo.example/retail/orders-api", "https://runbooks.contoso-demo.example/retail-api-orders", "https://github.com/contoso-demo/retail-api-orders", 99.9,
    "retail-api-catalog", "Product Catalog API", "Retail", "tier2", "commerce-team", "Director of Merchandising", "https://api.contoso-demo.example/catalog", "https://wiki.contoso-demo.example/retail/catalog-api", "https://runbooks.contoso-demo.example/retail-api-catalog", "https://github.com/contoso-demo/retail-api-catalog", 99.5,
    "pay-api-gateway", "Payment Gateway", "Payments", "tier1", "payments-team", "Head of Payments", "https://api.contoso-demo.example/payments", "https://wiki.contoso-demo.example/payments/gateway", "https://runbooks.contoso-demo.example/pay-api-gateway", "https://github.com/contoso-demo/pay-api-gateway", 99.95,
    "pay-worker-settlement", "Settlement Worker", "Payments", "tier1", "payments-team", "Head of Payments", "https://internal.contoso-demo.example/settlement", "https://wiki.contoso-demo.example/payments/settlement", "https://runbooks.contoso-demo.example/pay-worker-settlement", "https://github.com/contoso-demo/pay-worker-settlement", 99.5,
    "cust-api-profile", "Customer Profile API", "Customer", "tier2", "customer-team", "Director of Customer Experience", "https://api.contoso-demo.example/profile", "https://wiki.contoso-demo.example/customer/profile-api", "https://runbooks.contoso-demo.example/cust-api-profile", "https://github.com/contoso-demo/cust-api-profile", 99.5,
    "cust-worker-notify", "Notification Worker", "Customer", "tier3", "customer-team", "Director of Customer Experience", "https://internal.contoso-demo.example/notify", "https://wiki.contoso-demo.example/customer/notify-worker", "https://runbooks.contoso-demo.example/cust-worker-notify", "https://github.com/contoso-demo/cust-worker-notify", 99.0,
    "shared-api-inventory", "Inventory Service", "Platform", "tier1", "platform-team", "Head of Platform Engineering", "https://api.contoso-demo.example/inventory", "https://wiki.contoso-demo.example/platform/inventory", "https://runbooks.contoso-demo.example/shared-api-inventory", "https://github.com/contoso-demo/shared-api-inventory", 99.95
];`;

const portfolioQuery = `${catalogTable}
let health =
    AppRequests
    | where TimeGenerated {TimeRange}
    | summarize Requests = count(), Failures = countif(Success == false),
                P95ms = round(percentile(DurationMs, 95), 0)
      by workload = AppRoleName;
catalog
| join kind=leftouter health on workload
| extend Requests = coalesce(Requests, 0), Failures = coalesce(Failures, 0), P95ms = coalesce(P95ms, 0.0)
| extend Availability = iff(Requests == 0, 0.0, round(100.0 * (Requests - Failures) / Requests, 2))
| extend Status = case(
    Requests == 0,           "⚪ No data",
    Availability < slo - 1,  "🔴 Breaching SLO",
    Availability < slo,      "🟠 At risk",
                             "🟢 Healthy")
| project Application = displayName, Domain = domain, Tier = criticality, Status,
          Availability, SLO = slo, Requests, Failures, P95ms,
          Owner = owner, ['Business Owner'] = businessOwner,
          Website = appUrl, Docs = docsUrl, Runbook = runbookUrl, Repo = repoUrl
| order by Domain asc, Tier asc, Application asc`;

const domainQuery = `let domainOf = datatable(workload: string, Domain: string, Criticality: string)
[
    "retail-web","Retail","tier-1", "retail-api-orders","Retail","tier-1",
    "retail-api-catalog","Retail","tier-2", "pay-api-gateway","Payments","tier-1",
    "pay-worker-settlement","Payments","tier-1", "cust-api-profile","Customer","tier-2",
    "cust-worker-notify","Customer","tier-3", "shared-api-inventory","Platform","tier-1"
];
AppRequests
| where TimeGenerated {TimeRange}
| summarize Requests = count(), Failures = countif(Success == false),
            P95ms = percentile(DurationMs, 95)
  by workload = AppRoleName
| join kind=leftouter domainOf on workload
| summarize Services = dcount(workload), Requests = sum(Requests), Failures = sum(Failures),
            WorstP95ms = round(max(P95ms), 0),
            Tier1Services = dcountif(workload, Criticality == "tier-1")
  by Domain
| extend FailureRatePct = round(100.0 * Failures / Requests, 2),
         AvailabilityPct = round(100.0 * (Requests - Failures) / Requests, 3)
| extend Health = case(FailureRatePct >= 5.0, "🔴 Degraded",
                       FailureRatePct >= 1.0, "🟠 Warning", "🟢 Healthy")
| project Domain, Health, Services, Tier1Services, Requests, Failures,
          FailureRatePct, AvailabilityPct, WorstP95ms
| order by FailureRatePct desc`;

// The point of this tile: one query, every service, no workspace() or app() needed —
// because all eight Application Insights resources are workspace-based and share this
// workspace. That is the doc 02 thesis, visible in a single result set.
const crossQuery = `AppDependencies
| where TimeGenerated {TimeRange}
| where DependencyType !in ("InProc")
| summarize Calls = count(), Failures = countif(Success == false),
            P95ms = round(percentile(DurationMs, 95), 0)
  by Caller = AppRoleName, DependencyType, Target
| extend FailureRatePct = round(100.0 * Failures / Calls, 2)
| project Caller, DependencyType, Target, Calls, Failures, FailureRatePct, P95ms
| order by Calls desc`;

const driftQuery = `${catalogTable}
let emitting = AppRequests | where TimeGenerated {TimeRange}
    | summarize Requests = count() by workload = AppRoleName;
let catalogued = catalog | project workload, displayName;
emitting
| join kind=fullouter catalogued on workload
| extend Workload = coalesce(workload, workload1)
| extend Finding = case(
    isempty(workload1), "🔴 Emitting telemetry but NOT in catalog",
    isnull(Requests),   "🟠 In catalog but emitting no telemetry",
                        "🟢 Catalogued and emitting")
| project Workload, Finding, Application = displayName, Requests = coalesce(Requests, 0)
| order by Finding asc, Workload asc`;

// columnMatch is a SUBSTRING/regex match, not an exact name match. A rule for "App" also
// matches "Application", which silently turns the application-name column into a link and
// hides the names. Anchoring with ^...$ is what makes these rules mean what they look like.
const linkCol = (name, label) => ({
  columnMatch: `^${name}$`,
  formatter: 7,
  formatOptions: { linkTarget: "Url", linkLabel: label, linkIsContextBlade: false },
});

const query = (id, q, title, gridSettings, tab) => ({
  type: 3,
  content: {
    version: "KqlItem/1.0",
    query: q,
    size: 0,
    title,
    timeContext: { durationMs: 86400000 },
    queryType: 0,
    resourceType: "microsoft.operationalinsights/workspaces",
    crossComponentResources: [WS],
    ...(gridSettings ? { gridSettings } : {}),
  },
  name: id,
  conditionalVisibility: { parameterName: "selectedTab", comparison: "isEqualTo", value: tab },
});

// A graph step. Same query-step envelope as query() above, but carrying a graphSettings
// object instead of gridSettings.
//
// The visualization reads ONE mixed result set and separates nodes from edges by looking at
// nodeIdField vs sourceIdField/targetIdField — see the comment block in estate-map.kql.
//
// Two things worth knowing, because both are easy to get wrong:
//
//  * graphOrientation 2 is force-directed and re-seeds its simulation on every load, so the
//    layout is DIFFERENT each refresh. That is disorienting when demoing, so this defaults
//    to 1 (flow, left-to-right), which is deterministic. showOrientationToggles leaves the
//    force-directed option one click away.
//
//  * A node can show only a SINGLE tooltip string per content slot. The workaround is to
//    build the whole hover card as a column in KQL (Hover) and reference the column here
//    with the ["ColumnName"] form. Passing a literal would show the same text on every node.
const graph = (id, q, title, tab, graphSettings, extra = {}) => ({
  type: 3,
  content: {
    version: "KqlItem/1.0",
    query: q,
    size: 3,
    title,
    timeContext: { durationMs: 86400000 },
    queryType: 0,
    resourceType: "microsoft.operationalinsights/workspaces",
    crossComponentResources: [WS],
    visualization: "graph",
    graphSettings,
    ...extra,
  },
  name: id,
  conditionalVisibility: { parameterName: "selectedTab", comparison: "isEqualTo", value: tab },
});

const healthThresholds = [
  { operator: "==", thresholdValue: "Error", representation: "red" },
  { operator: "==", thresholdValue: "Warning", representation: "orange" },
  { operator: "==", thresholdValue: "Healthy", representation: "green" },
  { operator: "==", thresholdValue: "Infra", representation: "grayBlue" },
  { operator: "Default", thresholdValue: null, representation: "gray" },
];

// Nodes only — the honeycomb has no concept of edges, which is exactly why it is a useful
// companion to the map rather than a replacement: it answers "how is each domain doing"
// where the map answers "what talks to what".
const honeycombQuery = `AppRequests
| where TimeGenerated {TimeRange}
| summarize Calls = count(), Fails = countif(Success == false),
            P95 = round(percentile(DurationMs, 95), 0)
  by workload = AppRoleName
| join kind=leftouter (AppCatalog | project workload, displayName, domain, criticality, owner, slo) on workload
| extend FailPct = iff(Calls == 0, 0.0, round(100.0 * Fails / Calls, 2))
| extend Availability = round(100.0 - FailPct, 2)
| extend Domain = coalesce(domain, "unclassified"), Name = coalesce(displayName, workload)
| extend SloPct = toreal(slo)
| extend Status = case(Availability < SloPct - 1.0, "Error", Availability < SloPct, "Warning", "Healthy")
| extend Hover = strcat(Name, "\\ndomain: ", Domain, "   tier: ", coalesce(criticality, "n/a"),
                        "\\nowner: ", coalesce(owner, "n/a"),
                        "\\navailability: ", Availability, "%  (SLO ", SloPct, "%)",
                        "\\ncalls: ", Calls, "   failures: ", Fails,
                        "\\nP95: ", P95, " ms")
| project Name, Domain, Status, Availability, Calls, Hover
| order by Domain asc, Name asc`;

// Clicking a node on the map exports its id into {selectedNode}; this grid reacts to it.
// The map shows behaviour, this shows identity and where to go next — which is the whole
// argument for keeping a catalog alongside telemetry.
const nodeDetailQuery = `AppCatalog
| where "{selectedNode}" == "" or "{selectedNode}" == "*" or workload == "{selectedNode}"
| project Application = displayName, Workload = workload, Domain = domain, Tier = criticality,
          Owner = owner, ['Business Owner'] = businessOwner, SLO = toreal(slo),
          Website = appUrl, Docs = docsUrl, Runbook = runbookUrl, Repo = repoUrl`;

const workbook = {
  version: "Notebook/1.0",
  items: [
    {
      type: 1,
      content: {
        json:
          "## Application Portfolio\n\nOne view over eight Application Insights resources sharing a single Log Analytics workspace.\n\n" +
          "Telemetry answers *how is it behaving*. The service catalog answers *what is it, who owns it, and where do I go next* — " +
          "Azure cannot know that, so it is joined in here. The **Metadata quality** tab shows where the two disagree.",
      },
      name: "header",
    },
    {
      type: 9,
      content: {
        version: "KqlParameterItem/1.0",
        parameters: [
          {
            id: "p-timerange",
            version: "KqlParameterItem/1.0",
            name: "TimeRange",
            label: "Time range",
            type: 4,
            isRequired: true,
            typeSettings: { selectableValues: [
              { durationMs: 3600000 }, { durationMs: 14400000 }, { durationMs: 43200000 },
              { durationMs: 86400000 }, { durationMs: 172800000 },
            ], allowCustom: true },
            timeContext: { durationMs: 86400000 },
            value: { durationMs: 86400000 },
          },
        ],
        style: "pills",
        queryType: 0,
      },
      name: "parameters",
    },
    {
      type: 11,
      content: {
        version: "LinkItem/1.0",
        style: "tabs",
        links: [
          { id: "t1", cellValue: "selectedTab", linkTarget: "parameter", linkLabel: "Portfolio", subTarget: "portfolio", style: "link" },
          { id: "t5", cellValue: "selectedTab", linkTarget: "parameter", linkLabel: "Estate map", subTarget: "map", style: "link" },
          { id: "t2", cellValue: "selectedTab", linkTarget: "parameter", linkLabel: "Domain rollup", subTarget: "domains", style: "link" },
          { id: "t3", cellValue: "selectedTab", linkTarget: "parameter", linkLabel: "Cross-resource", subTarget: "cross", style: "link" },
          { id: "t4", cellValue: "selectedTab", linkTarget: "parameter", linkLabel: "Metadata quality", subTarget: "meta", style: "link" },
        ],
      },
      name: "tabs",
    },
    query("portfolio", portfolioQuery, "Portfolio — inventory, health and links", {
      formatters: [
        linkCol("Website", "Open app"), linkCol("Docs", "Open docs"),
        linkCol("Runbook", "Open runbook"), linkCol("Repo", "Open repo"),
        // redGreen = red at the low end, green at the high end. greenRed is the inverse and
        // paints 100% availability bright red, which is a memorably wrong-looking dashboard.
        { columnMatch: "^Availability$", formatter: 8, formatOptions: { palette: "redGreen" } },
        { columnMatch: "^P95ms$", formatter: 4, formatOptions: { palette: "blue" } },
      ],
      rowLimit: 50,
    }, "portfolio"),

    // ---- Estate map ------------------------------------------------------------------
    {
      type: 1,
      content: {
        json:
          "### Estate map\n\nApplication Map, but for the whole estate rather than one resource. " +
          "Edges come from joining each dependency to the request it caused, so these are real " +
          "call paths, not guesses.\n\n" +
          "Look for **Inventory Service**: it is called by both Retail and Payments. A shared " +
          "service is exactly why domain has to be a *tag*, not a boundary — when it degrades, " +
          "the blast radius crosses domains. Node colour is health, edge thickness is call volume. " +
          "**Hover** a node for owner, tier and SLO; **click** one to load its catalog entry below.",
      },
      name: "map-header",
      conditionalVisibility: { parameterName: "selectedTab", comparison: "isEqualTo", value: "map" },
    },
    graph("estate-map", estateMapQuery, "Service dependency map — all workloads", "map", {
      type: 0,
      topContent: { columnMatch: "Kind", formatter: 1 },
      centerContent: { columnMatch: "Name", formatter: 1, tooltipFormat: { tooltip: '["Hover"]' } },
      bottomContent: {
        columnMatch: "Calls",
        formatter: 1,
        numberFormat: { unit: 0, options: { style: "decimal", useGrouping: true, maximumFractionDigits: 0 } },
      },
      nodeIdField: "Id",
      sourceIdField: "SourceId",
      targetIdField: "TargetId",
      graphOrientation: 1,
      showOrientationToggles: true,
      edgeLabel: "EdgeLabel",
      edgeSize: "Calls",
      nodeSize: null,
      staticNodeSize: 120,
      colorSettings: { nodeColorField: "Status", type: 3, thresholdsGrid: healthThresholds },
      hivesMargin: 5,
    }, {
      exportFieldName: "Id",
      exportParameterName: "selectedNode",
      exportDefaultValue: "*",
      noDataMessage: "No dependency telemetry in this time range — is the simulator running?",
    }),
    query("map-detail", nodeDetailQuery, "Selected service — catalog entry", {
      formatters: [
        linkCol("Website", "Open app"), linkCol("Docs", "Open docs"),
        linkCol("Runbook", "Open runbook"), linkCol("Repo", "Open repo"),
      ],
      rowLimit: 10,
    }, "map"),
    graph("estate-hive", honeycombQuery, "Health by domain — every service, grouped", "map", {
      type: 2,
      centerContent: { columnMatch: "Name", formatter: 1, tooltipFormat: { tooltip: '["Hover"]' } },
      hivesContent: { columnMatch: "Domain", formatter: 1 },
      nodeIdField: "Name",
      groupByField: "Domain",
      graphOrientation: 3,
      showOrientationToggles: false,
      nodeSize: null,
      staticNodeSize: 90,
      colorSettings: { nodeColorField: "Status", type: 3, thresholdsGrid: healthThresholds },
      hivesMargin: 5,
    }),

    query("domains", domainQuery, "Health by business domain", { rowLimit: 20 }, "domains"),
    query("cross", crossQuery, "Every dependency across all eight resources — one query, no workspace() joins", { rowLimit: 100 }, "cross"),
    query("meta", driftQuery, "Catalog drift — telemetry vs. catalog", { rowLimit: 50 }, "meta"),
  ],
  fallbackResourceIds: [WS],
  $schema: "https://github.com/Microsoft/Application-Insights-Workbooks/blob/master/schema/workbook.json",
};

const template = {
  $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  parameters: {
    workbookSourceId: {
      type: "string",
      metadata: { description: "Resource id the workbook is scoped to — the Log Analytics workspace." },
    },
    // Workbook resource names must be GUIDs. guid() is deterministic from its inputs, so
    // re-running deploy.sh UPDATES this workbook rather than creating a duplicate every
    // time — which is what newGuid() would do.
    workbookName: { type: "string", defaultValue: "[guid(resourceGroup().id, 'portfolio-workbook')]" },
  },
  variables: { workbookContent: JSON.stringify(workbook) },
  resources: [
    {
      type: "Microsoft.Insights/workbooks",
      apiVersion: "2022-04-01",
      name: "[parameters('workbookName')]",
      location: "[resourceGroup().location]",
      kind: "shared",
      properties: {
        // Plain ASCII on purpose: this string passes through the az CLI on Windows, which
        // mangled an em dash here into a replacement character. Text inside serializedData
        // is unaffected, so the tile titles keep their typography.
        displayName: "Application Portfolio - Observability Demo",
        category: "workbook",
        sourceId: "[parameters('workbookSourceId')]",
        version: "Notebook/1.0",
        serializedData: "[replace(variables('workbookContent'), '__WORKSPACE_ID__', parameters('workbookSourceId'))]",
      },
    },
  ],
  outputs: {
    workbookId: { type: "string", value: "[resourceId('Microsoft.Insights/workbooks', parameters('workbookName'))]" },
  },
};

writeFileSync(new URL("./workbook-portfolio.json", import.meta.url), JSON.stringify(template, null, 2));
console.log("wrote workbook-portfolio.json");
