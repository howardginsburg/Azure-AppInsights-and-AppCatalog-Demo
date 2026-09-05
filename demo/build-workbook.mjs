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

// Every filterable tile shares these two parameters. Multi-select parameters expand to a
// quoted, comma-separated list ('Retail','Payments'), which drops straight into a
// dynamic([...]) literal. An empty selection expands to nothing, giving dynamic([]) — so
// "nothing selected" and "everything" are the same thing, and array_length() == 0 is the
// test for it. That is why no explicit "All" row is needed in the dropdowns.
const filterPrelude = `let selDomain = dynamic([{Domain}]);
let selTier = dynamic([{Tier}]);`;

// Applied to a table that carries the raw catalog column names.
const catalogWhere = `| where (array_length(selDomain) == 0 or domain in (selDomain))
    and (array_length(selTier) == 0 or criticality in (selTier))`;

// The catalog is joined from the AppCatalog saved function — the single query-time
// surface, published by sync-catalog.mjs. It is deliberately NOT inlined here: a copy in
// this file drifts silently from the one the estate map uses.
//
// Every column arrives as a string (except isActive), because a datatable() literal in a
// saved function has no way to carry a numeric type through from catalog.json. slo is
// therefore converted once, here, rather than at each use site.
const catalogTable = `${filterPrelude}
let catalog = AppCatalog
    | extend slo = toreal(slo)
    ${catalogWhere};`;

// A tree grid: one aggregated row per domain, expanding into its services. The domain row
// is not a label — it carries real rolled-up totals, so collapsing the tree gives an
// executive summary and expanding it gives the detail. That is the "drill in and out" ask.
//
// Parent/Child needs Id and ParentId columns present in the result even though both are
// hidden in the grid (formatter 5). Top-level rows are identified by an empty ParentId.
const portfolioQuery = `${catalogTable}
let health =
    AppRequests
    | where TimeGenerated {TimeRange}
    | summarize Requests = count(), Failures = countif(Success == false),
                P95ms = round(percentile(DurationMs, 95), 0)
      by workload = AppRoleName;
let services =
    catalog
    | join kind=leftouter health on workload
    | extend Requests = coalesce(Requests, 0), Failures = coalesce(Failures, 0), P95ms = coalesce(P95ms, 0.0)
    | extend Availability = iff(Requests == 0, 0.0, round(100.0 * (Requests - Failures) / Requests, 2))
    | extend Status = case(
        Requests == 0,           "⚪ No data",
        Availability < slo - 1,  "🔴 Breaching SLO",
        Availability < slo,      "🟠 At risk",
                                 "🟢 Healthy")
    | project Id = workload, ParentId = domain, Application = displayName, Domain = domain,
              Tier = criticality, Status, Availability, SLO = slo, Requests, Failures, P95ms,
              Owner = owner, ['Business Owner'] = businessOwner,
              Website = appUrl, Docs = docsUrl, Runbook = runbookUrl, Repo = repoUrl;
let domainRows =
    services
    | summarize Services = count(), Requests = sum(Requests), Failures = sum(Failures),
                P95ms = max(P95ms), SLO = min(SLO)
      by Domain
    | extend Availability = iff(Requests == 0, 0.0, round(100.0 * (Requests - Failures) / Requests, 2))
    | extend Status = case(
        Requests == 0,           "⚪ No data",
        Availability < SLO - 1,  "🔴 Breaching SLO",
        Availability < SLO,      "🟠 At risk",
                                 "🟢 Healthy")
    | project Id = Domain, ParentId = "", Application = strcat(Domain, "  —  ", Services, " services"),
              Domain, Tier = "", Status, Availability, SLO, Requests, Failures, P95ms,
              Owner = "", ['Business Owner'] = "",
              Website = "", Docs = "", Runbook = "", Repo = "";
union domainRows, services
| order by Domain asc, ParentId asc, Application asc`;

// Sourced from the same AppCatalog function as every other tile. The inline copy this
// replaced carried criticality as "tier-1" while the portfolio copy used "tier1" — two
// spellings of the same field, in the same file, that nothing would have flagged.
//
// The filter is applied AFTER the leftouter join, not to domainOf. Filtering the lookup
// side instead would leave every non-matching service in the result with Domain == "",
// quietly inventing an empty domain rather than removing the row.
const domainQuery = `${filterPrelude}
let domainOf = AppCatalog | project workload, Domain = domain, Criticality = criticality;
AppRequests
| where TimeGenerated {TimeRange}
| summarize Requests = count(), Failures = countif(Success == false),
            P95ms = percentile(DurationMs, 95)
  by workload = AppRoleName
| join kind=leftouter domainOf on workload
| where (array_length(selDomain) == 0 or Domain in (selDomain))
    and (array_length(selTier) == 0 or Criticality in (selTier))
| summarize Services = dcount(workload), Requests = sum(Requests), Failures = sum(Failures),
            WorstP95ms = round(max(P95ms), 0),
            Tier1Services = dcountif(workload, Criticality == "tier1")
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
//
// Filtering is by the CALLER's domain, so selecting Payments still shows the calls
// Payments makes into shared services owned by other domains.
const crossQuery = `${filterPrelude}
let cat = AppCatalog | project workload, domain, criticality;
AppDependencies
| where TimeGenerated {TimeRange}
| where DependencyType !in ("InProc")
| summarize Calls = count(), Failures = countif(Success == false),
            P95ms = round(percentile(DurationMs, 95), 0)
  by Caller = AppRoleName, DependencyType, Target
| join kind=leftouter cat on $left.Caller == $right.workload
| where (array_length(selDomain) == 0 or domain in (selDomain))
    and (array_length(selTier) == 0 or criticality in (selTier))
| extend FailureRatePct = round(100.0 * Failures / Calls, 2)
| project Caller, ['Caller domain'] = coalesce(domain, "unclassified"),
          DependencyType, Target, Calls, Failures, FailureRatePct, P95ms
| order by Calls desc`;

const driftQuery = `${filterPrelude}
let catalogued = AppCatalog | project workload, displayName, domain, criticality;
let emitting = AppRequests | where TimeGenerated {TimeRange}
    | summarize Requests = count() by workload = AppRoleName;
emitting
| join kind=fullouter catalogued on workload
| extend Workload = coalesce(workload, workload1)
| extend Finding = case(
    isempty(workload1), "🔴 Emitting telemetry but NOT in catalog",
    isnull(Requests),   "🟠 In catalog but emitting no telemetry",
                        "🟢 Catalogued and emitting")
| where isempty(workload1)
    or ((array_length(selDomain) == 0 or domain in (selDomain))
        and (array_length(selTier) == 0 or criticality in (selTier)))
| project Workload, Finding, Application = displayName,
          Domain = coalesce(domain, "—"), Requests = coalesce(Requests, 0)
| order by Finding asc, Workload asc`;

// columnMatch is a SUBSTRING/regex match, not an exact name match. A rule for "App" also
// matches "Application", which silently turns the application-name column into a link and
// hides the names. Anchoring with ^...$ is what makes these rules mean what they look like.
const linkCol = (name, label) => ({
  columnMatch: `^${name}$`,
  formatter: 7,
  formatOptions: { linkTarget: "Url", linkLabel: label, linkIsContextBlade: false },
});

const query = (id, q, title, gridSettings, tab, extra = {}) => ({
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
    ...extra,
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
  // Nodes the domain/tier filter did not select but that are kept on the map because they
  // talk to something that was. Gray reads as "context, not your problem".
  { operator: "==", thresholdValue: "Context", representation: "gray" },
  { operator: "Default", thresholdValue: null, representation: "gray" },
];

// Nodes only — the honeycomb has no concept of edges, which is exactly why it is a useful
// companion to the map rather than a replacement: it answers "how is each domain doing"
// where the map answers "what talks to what".
const honeycombQuery = `${filterPrelude}
AppRequests
| where TimeGenerated {TimeRange}
| summarize Calls = count(), Fails = countif(Success == false),
            P95 = round(percentile(DurationMs, 95), 0)
  by workload = AppRoleName
| join kind=leftouter (AppCatalog | project workload, displayName, domain, criticality, owner, slo) on workload
| where (array_length(selDomain) == 0 or domain in (selDomain))
    and (array_length(selTier) == 0 or criticality in (selTier))
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

// ---- Transaction drill ---------------------------------------------------------------
// Deliberately every FAILED request, not just entry points. Only retail-web ever starts a
// trace in this estate (verified: 3,857 roots, all retail-web), so an entry-point-only grid
// would be single-service and the domain filter on this tab would do nothing.
//
// Listing failures wherever they occur is also the better story: select a Payments failure
// and the trace below still resolves the whole customer journey back to the web tier,
// because it is fetched by OperationId rather than by service.
//
// _ItemId and _ResourceId are hidden columns — absent from getschema, but selectable, and
// they survive the join. _ItemId is what the RequestDetails link target consumes.
const failuresQuery = `${filterPrelude}
let cat = AppCatalog | project workload, displayName, domain, criticality;
AppRequests
| where TimeGenerated {TimeRange}
| where Success == false
| join kind=leftouter cat on $left.AppRoleName == $right.workload
| where (array_length(selDomain) == 0 or domain in (selDomain))
    and (array_length(selTier) == 0 or criticality in (selTier))
| project TimeGenerated, Service = coalesce(displayName, AppRoleName),
          Domain = coalesce(domain, "unclassified"), Operation = Name, ResultCode,
          ['Duration ms'] = round(DurationMs, 0), OperationId,
          Trace = _ItemId, Resource = _ResourceId
| top 100 by TimeGenerated desc`;

// The end-to-end transaction, rendered as a real call tree rather than a flat list.
//
// This works because App Insights already carries W3C trace context: every span has Id and
// ParentId, so the tree the services actually executed is reconstructable with no extra
// instrumentation. That is the whole "end to end flows including database calls" argument —
// SQL and Service Bus spans sit in the tree next to the HTTP ones.
//
// Two details that matter:
//
//  * The root request's ParentId is the OperationId, not empty, and the OperationId is not
//    itself a span Id. Left alone, the root would point at a non-existent parent and the
//    tree grid would have nothing to hang rows from. Rewriting any unresolvable ParentId to
//    "" promotes it to top level — and also rescues spans whose parent fell outside the
//    selected time range.
//
//  * Start +ms is relative to the first span, so the offsets read as a waterfall. An
//    absolute timestamp column forces the reader to do the subtraction themselves.
const transactionQuery = `let op = "{selectedOperation}";
let spans =
    union
      (AppRequests | where TimeGenerated {TimeRange} | where OperationId == op
        | project TimeGenerated, Service = AppRoleName, Kind = "request", Name,
                  Target = "", DurationMs = round(DurationMs, 1), Success, ResultCode,
                  Id, ParentId),
      (AppDependencies | where TimeGenerated {TimeRange} | where OperationId == op
        | project TimeGenerated, Service = AppRoleName, Kind = strcat("dep: ", DependencyType), Name,
                  Target, DurationMs = round(DurationMs, 1), Success, ResultCode,
                  Id, ParentId);
let ids = toscalar(spans | summarize make_set(Id));
let t0 = toscalar(spans | summarize min(TimeGenerated));
spans
| extend ParentId = iff(ParentId in (ids), ParentId, "")
| extend Status = iff(Success, "🟢 ok", "🔴 failed")
| project Id, ParentId, Span = Name, Service, Kind, Target,
          ['Start +ms'] = round(datetime_diff('microsecond', TimeGenerated, t0) / 1000.0, 1),
          ['Duration ms'] = DurationMs, Status, ResultCode
| order by ['Start +ms'] asc`;

// Exceptions raised anywhere in the same transaction. Kept as a separate tile rather than
// unioned into the tree because an exception is an event on a span, not a span itself —
// forcing it into the hierarchy would mean inventing a parent for it.
const transactionErrorQuery = `AppExceptions
| where TimeGenerated {TimeRange}
| where OperationId == "{selectedOperation}"
| project TimeGenerated, Service = AppRoleName, Type = ExceptionType,
          Message = OuterMessage, Method = Method
| order by TimeGenerated asc`;

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
          // Both filters are query-driven from AppCatalog, so adding a domain to
          // catalog.json makes it appear here with no workbook change.
          //
          // multiSelect with quote "'" and delimiter "," expands the selection to
          // 'Retail','Payments', which drops straight into dynamic([...]). Selecting
          // nothing expands to nothing, giving dynamic([]) — which every consuming query
          // treats as "no filter". That is why there is no explicit "All" entry, and why
          // these are not isRequired: an empty selection is the meaningful default.
          {
            id: "p-domain",
            version: "KqlParameterItem/1.0",
            name: "Domain",
            label: "Domain",
            type: 2,
            multiSelect: true,
            quote: "'",
            delimiter: ",",
            isRequired: false,
            query: "AppCatalog | distinct domain | order by domain asc | project value = domain, label = domain",
            typeSettings: { additionalResourceOptions: [], showDefault: false },
            queryType: 0,
            resourceType: "microsoft.operationalinsights/workspaces",
            crossComponentResources: [WS],
            value: [],
          },
          {
            id: "p-tier",
            version: "KqlParameterItem/1.0",
            name: "Tier",
            label: "Criticality",
            type: 2,
            multiSelect: true,
            quote: "'",
            delimiter: ",",
            isRequired: false,
            query: "AppCatalog | distinct criticality | order by criticality asc | project value = criticality, label = criticality",
            typeSettings: { additionalResourceOptions: [], showDefault: false },
            queryType: 0,
            resourceType: "microsoft.operationalinsights/workspaces",
            crossComponentResources: [WS],
            value: [],
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
          { id: "t6", cellValue: "selectedTab", linkTarget: "parameter", linkLabel: "Transactions", subTarget: "txn", style: "link" },
          { id: "t4", cellValue: "selectedTab", linkTarget: "parameter", linkLabel: "Metadata quality", subTarget: "meta", style: "link" },
        ],
      },
      name: "tabs",
    },
    query("portfolio", portfolioQuery, "Portfolio — inventory, health and links", {
      formatters: [
        // Id and ParentId exist only to give the tree its structure. Formatter 5 is Hidden,
        // which keeps them out of the grid without removing them from the result.
        { columnMatch: "^Id$", formatter: 5 },
        { columnMatch: "^ParentId$", formatter: 5 },
        linkCol("Website", "Open app"), linkCol("Docs", "Open docs"),
        linkCol("Runbook", "Open runbook"), linkCol("Repo", "Open repo"),
        // redGreen = red at the low end, green at the high end. greenRed is the inverse and
        // paints 100% availability bright red, which is a memorably wrong-looking dashboard.
        { columnMatch: "^Availability$", formatter: 8, formatOptions: { palette: "redGreen" } },
        { columnMatch: "^P95ms$", formatter: 4, formatOptions: { palette: "blue" } },
      ],
      rowLimit: 200,
      filter: true,
      // treeType 0 is Parent/Child, driven by idColumn/parentColumn. treeType 1 is Group By,
      // which builds its own grouping rows and cannot show a real aggregate on them — the
      // domain rows here carry rolled-up totals, so Parent/Child is the required form.
      hierarchySettings: {
        idColumn: "Id",
        parentColumn: "ParentId",
        treeType: 0,
        expanderColumn: "Application",
        expandTopLevel: false,
      },
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

    query("domains", domainQuery, "Health by business domain", {
      formatters: [
        // A context blade shows the whole row as a property grid in a side pane, so wide
        // results stay readable without widening columns or navigating away.
        { columnMatch: "^Domain$", formatter: 7,
          formatOptions: { linkTarget: "GenericDetails", linkIsContextBlade: true } },
        { columnMatch: "^AvailabilityPct$", formatter: 8, formatOptions: { palette: "redGreen" } },
        { columnMatch: "^Requests$", formatter: 4, formatOptions: { palette: "blue" } },
      ],
      rowLimit: 20,
      filter: true,
    }, "domains"),
    query("cross", crossQuery, "Every dependency across all eight resources — one query, no workspace() joins", {
      formatters: [
        { columnMatch: "^Target$", formatter: 7,
          formatOptions: { linkTarget: "GenericDetails", linkIsContextBlade: true } },
        { columnMatch: "^Calls$", formatter: 4, formatOptions: { palette: "blue" } },
        { columnMatch: "^FailureRatePct$", formatter: 8, formatOptions: { palette: "greenRed" } },
      ],
      rowLimit: 100,
      filter: true,
    }, "cross"),

    // ---- Transactions ----------------------------------------------------------------
    {
      type: 1,
      content: {
        json:
          "### End-to-end transactions\n\nEvery failed request in the estate, from any service. " +
          "**Click a row** to reconstruct the entire distributed transaction it belongs to — " +
          "across every service, including the SQL and Service Bus calls.\n\n" +
          "Nothing extra was instrumented to make this work. The services propagate W3C trace " +
          "context, so each span already carries its own id and its parent's; the tree below is " +
          "that structure, read back out. Select a **Payments** failure and the trace still " +
          "resolves back to the web tier that started it, because it is fetched by operation, " +
          "not by service.",
      },
      name: "txn-header",
      conditionalVisibility: { parameterName: "selectedTab", comparison: "isEqualTo", value: "txn" },
    },
    query("txn-failures", failuresQuery, "Failed requests — click one to trace it", {
      formatters: [
        { columnMatch: "^OperationId$", formatter: 5 },
        // Best-effort jump to the Application Insights transaction search blade. The
        // workbook is scoped to a workspace rather than a component, so this is the one
        // link here that depends on the portal resolving the owning resource itself —
        // the Resource column beside it is the guaranteed fallback.
        { columnMatch: "^Trace$", formatter: 7,
          formatOptions: { linkTarget: "RequestDetails", linkLabel: "Details" } },
        { columnMatch: "^Resource$", formatter: 7,
          formatOptions: { linkTarget: "Resource", linkLabel: "App Insights" } },
        { columnMatch: "^Duration ms$", formatter: 4, formatOptions: { palette: "orange" } },
      ],
      rowLimit: 100,
      filter: true,
    }, "txn", {
      exportFieldName: "OperationId",
      exportParameterName: "selectedOperation",
      exportDefaultValue: "",
      noDataMessage: "No failed requests in this time range for the selected filters.",
    }),
    {
      ...query("txn-tree", transactionQuery, "Distributed trace — the full call tree", {
        formatters: [
          { columnMatch: "^Id$", formatter: 5 },
          { columnMatch: "^ParentId$", formatter: 5 },
          { columnMatch: "^Duration ms$", formatter: 4, formatOptions: { palette: "blue" } },
        ],
        rowLimit: 500,
        hierarchySettings: {
          idColumn: "Id",
          parentColumn: "ParentId",
          treeType: 0,
          expanderColumn: "Span",
          expandTopLevel: true,
        },
      }, "txn"),
      // Two conditions at once, which the singular conditionalVisibility cannot express.
      // An entry with isNotEqualTo and no value means "this parameter is not empty", so the
      // tree stays hidden until a row above is actually selected.
      conditionalVisibilities: [
        { parameterName: "selectedTab", comparison: "isEqualTo", value: "txn" },
        { parameterName: "selectedOperation", comparison: "isNotEqualTo" },
      ],
    },
    {
      ...query("txn-errors", transactionErrorQuery, "Exceptions raised in this transaction", {
        formatters: [
          { columnMatch: "^Message$", formatter: 7,
            formatOptions: { linkTarget: "GenericDetails", linkIsContextBlade: true } },
        ],
        rowLimit: 50,
      }, "txn"),
      conditionalVisibilities: [
        { parameterName: "selectedTab", comparison: "isEqualTo", value: "txn" },
        { parameterName: "selectedOperation", comparison: "isNotEqualTo" },
      ],
    },

    query("meta", driftQuery, "Catalog drift — telemetry vs. catalog", {
      formatters: [
        { columnMatch: "^Workload$", formatter: 7,
          formatOptions: { linkTarget: "GenericDetails", linkIsContextBlade: true } },
      ],
      rowLimit: 50,
      filter: true,
    }, "meta"),
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
