// Generates workbook.json, the Application Portfolio workbook that infra/main.bicep deploys.
//
//   node workbook/build-workbook.mjs
//
// The workbook is authored here as a normal object; JSON.stringify does the escaping that a
// hand-edited serializedData string would need. Two tokens are replaced at deploy time by Bicep:
//   __WORKSPACE_ID__  the Log Analytics workspace resource ID
//   __CATALOG_URL__   the catalog app's base URL
//
// Classification (domain, criticality, owner) comes from the Azure tags on each app's
// Application Insights resource, read through Azure Resource Graph with arg(). Nothing about
// individual apps is defined here, so apps a customer adds appear without changing this file.

import { readFileSync, writeFileSync } from "node:fs";

const WS = "__WORKSPACE_ID__";
const CATALOG = "__CATALOG_URL__";
// Bicep's loadTextContent() accepts at most 131,072 characters.
const MAX_CHARS = 120_000;

// Line endings are normalized so the output is identical however Git checked the sources out.
const readKql = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const estateKql = readKql("../standalone-catalog-graph/server/estate.kql");
const estateOverlay = readKql("./estate-map-overlay.kql");

// The tag lookup, defined once. A plain join against arg("") fails when the query also uses
// percentile(), so the tags are collected into a single bag keyed by lowercase resource ID and
// looked up per row. arg() is in preview and returns at most 1,000 Resource Graph rows.
const tagLookup = `let appTags = toscalar(
    arg("").Resources
    | where type =~ "microsoft.insights/components"
    | where tolower(tostring(properties.WorkspaceResourceId)) == tolower("${WS}")
    | summarize make_bag(bag_pack(tolower(id), tags)));`;

// Multi-select parameters expand to 'Retail','Payments', which drops into dynamic([...]).
// An empty selection gives dynamic([]), which every query treats as "no filter".
const filterPrelude = `${tagLookup}
let selDomain = dynamic([{Domain}]);
let selTier = dynamic([{Tier}]);`;

// Adds Domain, Tier and Owner from the tags on the row's resource (column Resource).
const classify = `| extend tg = appTags[Resource]
| extend Domain = tostring(tg.domain), Tier = tostring(tg.criticality), Owner = tostring(tg.owner)
| extend Domain = iff(isempty(Domain), "untagged", Domain)`;

const filterWhere = `| where (array_length(selDomain) == 0 or Domain in (selDomain))
    and (array_length(selTier) == 0 or Tier in (selTier))`;

const health = (col) => `case(${col} >= 5.0, "🔴 Error", ${col} >= 1.0, "🟠 Warning", "🟢 Healthy")`;
const catalogLink = (col) => `strcat("${CATALOG}/?workload=", url_encode_component(${col}))`;

// Request health per app, with its resource for the tag lookup.
const appHealth = `AppRequests
| where TimeGenerated {TimeRange}
| summarize Requests = count(), Failures = countif(Success == false),
            P95ms = round(percentile(DurationMs, 95), 0),
            Resource = take_any(tolower(_ResourceId))
  by App = AppRoleName
${classify}`;

// A tree: one rolled-up row per domain that expands into its apps. Collapsed, it is the
// executive summary; expanded, the detail. Domain ids are prefixed so an app and a domain
// that share a name can't collide.
const portfolioQuery = `${filterPrelude}
let apps =
    ${appHealth.replaceAll("\n", "\n    ")}
    ${filterWhere.replaceAll("\n", "\n    ")}
    | extend FailurePct = round(100.0 * Failures / Requests, 2);
let domains =
    apps
    | summarize Apps = count(), Requests = sum(Requests), Failures = sum(Failures), P95ms = max(P95ms) by Domain
    | extend FailurePct = round(100.0 * Failures / Requests, 2);
union
    (domains
     | project Id = strcat("domain:", Domain), ParentId = "", Application = strcat(Domain, "  —  ", Apps, " apps"),
               Domain, Criticality = "", Owner = "", Status = ${health("FailurePct")},
               Availability = round(100.0 - FailurePct, 2), Requests, Failures, P95ms, Catalog = "", Resource = ""),
    (apps
     | project Id = App, ParentId = strcat("domain:", Domain), Application = App, Domain,
               Criticality = Tier, Owner, Status = ${health("FailurePct")},
               Availability = round(100.0 - FailurePct, 2), Requests, Failures, P95ms,
               Catalog = ${catalogLink("App")}, Resource)
| order by Domain asc, ParentId asc, Application asc`;

const domainQuery = `${filterPrelude}
${appHealth}
${filterWhere}
| summarize Apps = dcount(App), Requests = sum(Requests), Failures = sum(Failures),
            WorstP95ms = max(P95ms), Tier1Apps = dcountif(App, Tier == "tier1")
  by Domain
| extend FailureRatePct = round(100.0 * Failures / Requests, 2)
| extend AvailabilityPct = round(100.0 - FailureRatePct, 3)
| project Domain, Health = ${health("FailureRatePct")}, Apps, Tier1Apps, Requests, Failures,
          FailureRatePct, AvailabilityPct, WorstP95ms
| order by FailureRatePct desc`;

// One query, every app, no workspace() or app() calls: all the Application Insights resources
// are workspace-based and share this workspace. Filtering is by the caller's domain, so
// selecting Payments still shows the calls Payments makes into other domains' services.
const crossQuery = `${filterPrelude}
AppDependencies
| where TimeGenerated {TimeRange}
| where DependencyType !in ("InProc")
| summarize Calls = count(), Failures = countif(Success == false),
            P95ms = round(percentile(DurationMs, 95), 0),
            Resource = take_any(tolower(_ResourceId))
  by Caller = AppRoleName, DependencyType, Target
${classify}
${filterWhere}
| extend FailureRatePct = round(100.0 * Failures / Calls, 2)
| project Caller, ['Caller domain'] = Domain, DependencyType, Target, Calls, Failures, FailureRatePct, P95ms
| order by Calls desc`;

// Nodes only. The honeycomb answers "how is each domain doing"; the map answers "what talks to what".
const honeycombQuery = `${filterPrelude}
${appHealth}
${filterWhere}
| extend FailPct = iff(Requests == 0, 0.0, round(100.0 * Failures / Requests, 2))
| extend Status = case(FailPct >= 5.0, "Error", FailPct >= 1.0, "Warning", "Healthy")
| extend Hover = strcat(App, "\\ndomain: ", Domain,
                        "   criticality: ", iff(isempty(Tier), "n/a", Tier),
                        "\\nowner: ", iff(isempty(Owner), "n/a", Owner),
                        "\\nfailure rate: ", FailPct, "%",
                        "\\ncalls: ", Requests, "   failures: ", Failures,
                        "\\nP95: ", P95ms, " ms")
| project Name = App, Domain, Status, FailPct, Calls = Requests, Hover
| order by Domain asc, Name asc`;

// Clicking a node on the map exports its id into {selectedNode}. The map shows behavior;
// this grid shows classification and where to go next.
const nodeDetailQuery = `${tagLookup}
let sel = "{selectedNode}";
${appHealth}
| where sel == "" or sel == "*" or App == sel
| project App, Domain, Criticality = Tier, Owner, Requests, Failures, P95ms,
          Catalog = ${catalogLink("App")}, Resource
| order by App asc`;

const estateMapQuery = `${filterPrelude}
${estateKql}
${estateOverlay}`;

// Every failed request in the estate, from any service, not just entry points. Selecting a
// Payments failure still resolves the whole customer journey, because the trace below is
// fetched by OperationId rather than by service.
//
// _ItemId and _ResourceId are hidden columns: absent from getschema, but selectable.
// _ItemId is what the RequestDetails link target consumes.
const failuresQuery = `${filterPrelude}
AppRequests
| where TimeGenerated {TimeRange}
| where Success == false
| extend Resource = tolower(_ResourceId)
${classify}
${filterWhere}
| project TimeGenerated, App = AppRoleName, Domain, Operation = Name, ResultCode,
          ['Duration ms'] = round(DurationMs, 0), OperationId, Trace = _ItemId, Resource
| top 100 by TimeGenerated desc`;

// The end-to-end transaction as a call tree. W3C trace context gives every span an Id and a
// ParentId, so the tree the services executed can be read straight back out, SQL and Service
// Bus spans included.
//
// A root request's ParentId is the OperationId, which is not itself a span Id, so any
// unresolvable ParentId is rewritten to "" to make it a top-level row. That also rescues spans
// whose parent fell outside the time range. Start +ms is relative to the first span, so the
// offsets read as a waterfall.
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

// Exceptions in the same transaction. Kept out of the tree because an exception is an event on
// a span, not a span; forcing it into the hierarchy would mean inventing a parent for it.
const transactionErrorQuery = `AppExceptions
| where TimeGenerated {TimeRange}
| where OperationId == "{selectedOperation}"
| project TimeGenerated, Service = AppRoleName, Type = ExceptionType,
          Message = OuterMessage, Method = Method
| order by TimeGenerated asc`;

// Registrations versus reality. Ignores the Domain and Criticality filters, because the
// findings that matter most are apps with no classification to filter on.
const metadataQuery = `${tagLookup}
let registered =
    print b = appTags
    | mv-expand kind=array kv = b
    | project Resource = tostring(kv[0]), tags = kv[1];
let reporting =
    union AppRequests, AppDependencies, AppTraces
    | where TimeGenerated {TimeRange}
    | summarize Rows = count(), Apps = make_set(AppRoleName, 10) by Resource = tolower(_ResourceId);
registered
| join kind=fullouter reporting on Resource
| extend Resource = coalesce(Resource, Resource1)
| extend Domain = tostring(tags.domain), Criticality = tostring(tags.criticality), Owner = tostring(tags.owner)
| extend Missing = trim(", ", strcat(iff(isempty(Domain), "domain, ", ""),
                                     iff(isempty(Criticality), "criticality, ", ""),
                                     iff(isempty(Owner), "owner", "")))
| extend Finding = case(
    isnull(Rows),        "🟠 Registered, no telemetry in this time range",
    isnotempty(Missing), strcat("🔴 Missing tags: ", Missing),
                         "🟢 Registered and reporting")
| project Finding, Resource, Apps, Domain, Criticality, Owner, Rows = coalesce(Rows, 0)
| order by Finding asc, Resource asc`;

// Dropdown values come from the tags themselves, so a new domain appears with no change here.
const tagValues = (tag) => `${tagLookup}
print b = appTags
| mv-expand kind=array kv = b
| extend v = tostring(kv[1].${tag})
| where isnotempty(v)
| distinct v
| order by v asc
| project value = v, label = v`;

// columnMatch is a regex, not an exact name, so a rule for "App" would also match "Application".
// Anchoring with ^...$ makes each rule mean what it looks like.
const linkCol = (name, label) => ({
  columnMatch: `^${name}$`,
  formatter: 7,
  formatOptions: { linkTarget: "Url", linkLabel: label, linkIsContextBlade: false },
});
const resourceCol = { columnMatch: "^Resource$", formatter: 7, formatOptions: { linkTarget: "Resource", linkLabel: "App Insights" } };
const catalogCol = linkCol("Catalog", "Open in catalog");

const visibleOn = (tab) => ({ parameterName: "selectedTab", comparison: "isEqualTo", value: tab });

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
  conditionalVisibility: visibleOn(tab),
});

// A graph step. The visualization reads one mixed result set and tells nodes from edges by
// nodeIdField versus sourceIdField/targetIdField.
//
// graphOrientation 2 (force-directed) re-seeds on every load, so the picture moves between
// refreshes. 1 (flow, left to right) is deterministic; the toggle keeps force-directed one click away.
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
  conditionalVisibility: visibleOn(tab),
});

const text = (name, markdown, tab) => ({
  type: 1,
  content: { json: markdown },
  name,
  ...(tab ? { conditionalVisibility: visibleOn(tab) } : {}),
});

const healthThresholds = [
  { operator: "==", thresholdValue: "Error", representation: "red" },
  { operator: "==", thresholdValue: "Warning", representation: "orange" },
  { operator: "==", thresholdValue: "Healthy", representation: "green" },
  { operator: "==", thresholdValue: "Infra", representation: "grayBlue" },
  // Neighbours kept on the map for context, outside the current filter.
  { operator: "==", thresholdValue: "Context", representation: "gray" },
  { operator: "Default", thresholdValue: null, representation: "gray" },
];

const tagParameter = (id, name, label, tag) => ({
  id,
  version: "KqlParameterItem/1.0",
  name,
  label,
  type: 2,
  multiSelect: true,
  quote: "'",
  delimiter: ",",
  isRequired: false,
  query: tagValues(tag),
  typeSettings: { additionalResourceOptions: [], showDefault: false },
  queryType: 0,
  resourceType: "microsoft.operationalinsights/workspaces",
  crossComponentResources: [WS],
  value: [],
});

const tabs = [
  ["portfolio", "Portfolio"],
  ["map", "Estate map"],
  ["domains", "Domain rollup"],
  ["cross", "Cross-resource"],
  ["txn", "Transactions"],
  ["meta", "Metadata quality"],
];

const workbook = {
  version: "Notebook/1.0",
  items: [
    text(
      "header",
      "## Application Portfolio\n\n" +
        "Every Application Insights resource linked to this workspace, in one view. " +
        "Each app's **domain**, **criticality**, and **owner** come from the Azure tags on its Application Insights resource. " +
        "Business context (what the app is for, its SLO, runbook, and on-call) lives in the " +
        `[catalog app](${CATALOG}); every app links to it.`,
    ),
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
            typeSettings: {
              selectableValues: [
                { durationMs: 3600000 }, { durationMs: 14400000 }, { durationMs: 43200000 },
                { durationMs: 86400000 }, { durationMs: 172800000 }, { durationMs: 604800000 },
              ],
              allowCustom: true,
            },
            timeContext: { durationMs: 86400000 },
            value: { durationMs: 86400000 },
          },
          tagParameter("p-domain", "Domain", "Domain", "domain"),
          tagParameter("p-tier", "Tier", "Criticality", "criticality"),
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
        links: tabs.map(([value, label]) => ({
          id: `t-${value}`, cellValue: "selectedTab", linkTarget: "parameter", linkLabel: label, subTarget: value, style: "link",
        })),
      },
      name: "tabs",
    },

    // ---- Portfolio -------------------------------------------------------------------
    query("portfolio", portfolioQuery, "Portfolio: health by domain and app", {
      formatters: [
        // Id and ParentId give the tree its structure; formatter 5 hides them.
        { columnMatch: "^Id$", formatter: 5 },
        { columnMatch: "^ParentId$", formatter: 5 },
        catalogCol,
        resourceCol,
        // redGreen is red at the low end and green at the high end, which suits availability.
        { columnMatch: "^Availability$", formatter: 8, formatOptions: { palette: "redGreen" } },
        { columnMatch: "^P95ms$", formatter: 4, formatOptions: { palette: "blue" } },
      ],
      rowLimit: 500,
      filter: true,
      // treeType 0 is Parent/Child (idColumn/parentColumn). Group By (1) can't show real
      // totals on its grouping rows, and the domain rows here carry rolled-up totals.
      hierarchySettings: {
        idColumn: "Id",
        parentColumn: "ParentId",
        treeType: 0,
        expanderColumn: "Application",
        expandTopLevel: false,
      },
    }, "portfolio"),

    // ---- Estate map ------------------------------------------------------------------
    text(
      "map-header",
      "### Estate map\n\nApplication Map for the whole estate rather than one resource. " +
        "Edges come from joining each dependency to the request it caused, so they are real call paths. " +
        "A service called from more than one domain shows the blast radius crossing domains. " +
        "Node color is health and edge thickness is call volume. **Hover** a node for its tags; **click** one to load it below.",
      "map",
    ),
    graph("estate-map", estateMapQuery, "Service dependency map: all apps", "map", {
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
      noDataMessage: "No dependency telemetry in this time range. Is the simulator running?",
    }),
    query("map-detail", nodeDetailQuery, "Selected app", {
      formatters: [catalogCol, resourceCol],
      rowLimit: 50,
    }, "map"),
    graph("estate-hive", honeycombQuery, "Health by domain: every app, grouped", "map", {
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

    // ---- Domain rollup and cross-resource ----------------------------------------------
    query("domains", domainQuery, "Health by business domain", {
      formatters: [
        // A context blade shows the whole row in a side pane, so wide rows stay readable.
        { columnMatch: "^Domain$", formatter: 7, formatOptions: { linkTarget: "GenericDetails", linkIsContextBlade: true } },
        { columnMatch: "^AvailabilityPct$", formatter: 8, formatOptions: { palette: "redGreen" } },
        { columnMatch: "^Requests$", formatter: 4, formatOptions: { palette: "blue" } },
      ],
      rowLimit: 50,
      filter: true,
    }, "domains"),
    query("cross", crossQuery, "Every dependency across all apps: one query, no workspace() joins", {
      formatters: [
        { columnMatch: "^Target$", formatter: 7, formatOptions: { linkTarget: "GenericDetails", linkIsContextBlade: true } },
        { columnMatch: "^Calls$", formatter: 4, formatOptions: { palette: "blue" } },
        { columnMatch: "^FailureRatePct$", formatter: 8, formatOptions: { palette: "greenRed" } },
      ],
      rowLimit: 200,
      filter: true,
    }, "cross"),

    // ---- Transactions ----------------------------------------------------------------
    text(
      "txn-header",
      "### End-to-end transactions\n\nEvery failed request in the estate, from any app. " +
        "**Click a row** to rebuild the whole distributed transaction it belongs to, across every app, " +
        "including the SQL and Service Bus calls.\n\n" +
        "Nothing extra was instrumented to make this work. The apps propagate W3C trace context, so each span " +
        "already carries its own id and its parent's; the tree below reads that structure back out.",
      "txn",
    ),
    query("txn-failures", failuresQuery, "Failed requests: click one to trace it", {
      formatters: [
        { columnMatch: "^OperationId$", formatter: 5 },
        // Opens the Application Insights transaction view for the item.
        { columnMatch: "^Trace$", formatter: 7, formatOptions: { linkTarget: "RequestDetails", linkLabel: "Details" } },
        resourceCol,
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
      ...query("txn-tree", transactionQuery, "Distributed trace: the full call tree", {
        formatters: [
          { columnMatch: "^Id$", formatter: 5 },
          { columnMatch: "^ParentId$", formatter: 5 },
          { columnMatch: "^Duration ms$", formatter: 4, formatOptions: { palette: "blue" } },
        ],
        rowLimit: 500,
        hierarchySettings: { idColumn: "Id", parentColumn: "ParentId", treeType: 0, expanderColumn: "Span", expandTopLevel: true },
      }, "txn"),
      // Two conditions, which the singular conditionalVisibility cannot express. isNotEqualTo
      // with no value means "not empty", so the tree stays hidden until a row is selected.
      conditionalVisibility: undefined,
      conditionalVisibilities: [visibleOn("txn"), { parameterName: "selectedOperation", comparison: "isNotEqualTo" }],
    },
    {
      ...query("txn-errors", transactionErrorQuery, "Exceptions raised in this transaction", {
        formatters: [
          { columnMatch: "^Message$", formatter: 7, formatOptions: { linkTarget: "GenericDetails", linkIsContextBlade: true } },
        ],
        rowLimit: 50,
      }, "txn"),
      conditionalVisibility: undefined,
      conditionalVisibilities: [visibleOn("txn"), { parameterName: "selectedOperation", comparison: "isNotEqualTo" }],
    },

    // ---- Metadata quality --------------------------------------------------------------
    text(
      "meta-header",
      "### Metadata quality\n\nCompares the Application Insights resources linked to this workspace with the telemetry they receive. " +
        "🔴 rows are missing a required tag, 🟠 rows are registered but silent, and 🟢 rows are healthy. " +
        "This tab ignores the Domain and Criticality filters, because untagged apps have nothing to filter on.",
      "meta",
    ),
    query("meta", metadataQuery, "Registrations versus telemetry", {
      formatters: [resourceCol],
      rowLimit: 500,
      filter: true,
    }, "meta"),
  ],
  fallbackResourceIds: [WS],
  $schema: "https://github.com/Microsoft/Application-Insights-Workbooks/blob/master/schema/workbook.json",
};

const json = JSON.stringify(workbook, null, 2) + "\n";
if (json.length > MAX_CHARS) {
  throw new Error(`workbook.json is ${json.length} characters; Bicep's loadTextContent() limit is 131,072.`);
}
writeFileSync(new URL("./workbook.json", import.meta.url), json);
console.log(`wrote workbook/workbook.json (${json.length.toLocaleString()} characters)`);
