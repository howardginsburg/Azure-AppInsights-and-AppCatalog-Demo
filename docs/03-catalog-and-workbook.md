# Catalog and workbook

The portfolio workbook and the Estate Atlas catalog app show the same estate, assembled at query time. Each fact lives in exactly one source.

| Source | Holds | Key | Read by |
|---|---|---|---|
| Telemetry, in Log Analytics | Requests, dependencies, logs, exceptions, and the health derived from them | `AppRoleName` (the app's service name) and `_ResourceId` | Both |
| Azure tags, through Azure Resource Graph | `domain`, `criticality`, `owner` | The Application Insights resource ID | Both |
| The catalog, in Azure SQL | Display name, description, business owner, SLO, on-call, app, docs, runbook, and repo links | The service name | The catalog app. The workbook links to it |

```mermaid
flowchart LR
    TEL[("Log Analytics<br/>telemetry")] -->|"AppRoleName, _ResourceId"| WB["Portfolio workbook"]
    TAGS["Resource Graph<br/>Application Insights tags"] -->|"resource ID"| WB
    TEL --> APP["Estate Atlas"]
    TAGS --> APP
    SQL[("Azure SQL<br/>catalog")] -->|"service name"| APP
    WB -.->|"Open in catalog"| APP

    style SQL fill:#ffe6cc,stroke:#d79b00,color:#1a1a1a
    style WB fill:#d5e8d4,stroke:#82b366,color:#1a1a1a
    style APP fill:#d5e8d4,stroke:#82b366,color:#1a1a1a
```

Health is never stored. Classification is never copied into the catalog, and business context is never copied into tags. A change in one place shows up everywhere on the next query.

## Register an app

An app is registered when its Application Insights resource is linked to the shared workspace and carries the three tags. [`add-app.sh`](../add-app.sh) deploys [`infra/modules/app.bicep`](../infra/modules/app.bicep) to do exactly that:

```bash
./add-app.sh orders-api --domain Sales --criticality tier1 --owner sales-team
```

Teams with their own infrastructure as code can copy the module. Several service names can report to one resource, such as an API and its worker: each appears separately, and both inherit the resource's tags.

These are different states, not one registration action:

| State | Where to look |
|---|---|
| Resource registered, no telemetry yet | Workbook **Metadata quality**, including the selected time range |
| Requests or processing spans received | Estate graph, using the effective service name and the tags of the receiving resource |
| Business context added | Catalog UI/API; the entry is joined onto the observed graph app |

A catalog entry does not create telemetry or force a graph node to exist. Separate environments use [separate platform views](01-topology.md#one-environment-per-deployment).

## The workbook

*Application Portfolio* is deployed by [`infra/main.bicep`](../infra/main.bicep) from [`workbook/workbook.json`](../workbook/workbook.json). Domain and Criticality filters apply to every tab except Metadata quality.

| Tab | Shows |
|---|---|
| **Portfolio** | A tree with one row per domain, rolled up, expanding into its apps: availability, requests, failures, P95, owner, and links to the app's catalog entry and its Application Insights resource |
| **Estate map** | The dependency graph of every app and backing service, a detail grid for the selected node, and a honeycomb of health by domain |
| **Domain rollup** | Health per domain, including how many `tier1` apps each has |
| **Cross-resource** | Every dependency of every app, from one query with no `workspace()` joins |
| **Transactions** | Every failed request. Select one to rebuild its whole call tree across apps, with the exceptions raised along the way |
| **Metadata quality** | Registered resources that are missing tags or that sent no telemetry in the time range |

An app is **Healthy** below 1% failed requests, **Warning** from 1%, and **Error** from 5%, over the selected time range. These are observed failure-rate labels, not SLO evaluation. An app can be marked Healthy while having unacceptable latency. The catalog's SLO is business context, not an alert or a calculation input.

![Azure portal portfolio workbook showing domain health and expanded application rows](images/azure-workbook-portfolio.png)

*Actual deployed workbook with synthetic telemetry. Domain rows expand into apps, and each app links to its catalog entry and Application Insights resource.*

On the estate map, a filter picks a *focus* rather than removing nodes. Selecting Payments keeps the Payments apps in color and everything one hop away in gray. A plain filter would delete the Retail caller of a shared service, and the map would quietly lose the cross-domain fan-in that matters most.

### How the workbook reads tags

Each query looks up the tags of the resource that received each row, through [Azure Resource Graph from Log Analytics](https://learn.microsoft.com/azure/azure-monitor/logs/azure-monitor-data-explorer-proxy):

```kusto
let appTags = toscalar(
    arg("").Resources
    | where type =~ "microsoft.insights/components"
    | where tolower(tostring(properties.WorkspaceResourceId)) == tolower("<workspace resource ID>")
    | summarize make_bag(bag_pack(tolower(id), tags)));
AppRequests
| summarize Requests = count(), P95 = percentile(DurationMs, 95), Resource = take_any(tolower(_ResourceId)) by AppRoleName
| extend Domain = tostring(appTags[Resource].domain)
```

A plain `join` against `arg("")` fails when the same query uses `percentile()`, so the tags are collected into one lookup bag first. Limits to know:

- `arg()` in Log Analytics is in preview.
- Only the first 1,000 Resource Graph rows are returned: here, 1,000 Application Insights resources linked to the workspace.
- It runs as the person viewing the workbook. Viewers see tags only for resources they can read; the rest show as `untagged`.
- Resource Graph failures can produce partial results or a query error. Inspect the workbook's query details; do not assume that `untagged` means the Azure tags are absent.

### Change the workbook

The workbook is generated. Edit [`workbook/build-workbook.mjs`](../workbook/build-workbook.mjs), then redeploy:

```bash
node workbook/build-workbook.mjs   # deploy.sh runs this too
./deploy.sh
```

The estate map's topology query is [`standalone-catalog-graph/server/estate.kql`](../standalone-catalog-graph/server/estate.kql), shared with the catalog app. The workbook adds tags, hover text, and focus filtering in [`workbook/estate-map-overlay.kql`](../workbook/estate-map-overlay.kql). The generator fails if the JSON grows past what Bicep's `loadTextContent()` accepts.

## The catalog app

Estate Atlas runs on App Service with a system-assigned managed identity. That identity reads the workspace and the tags, and is the Microsoft Entra admin of the catalog database.

Those permissions simplify this starter, including schema creation; they are not a production least-privilege design. Browser access is independent of the backend identity.

- **Estate graph.** One node per app and backing service, from the shared topology query. Fill is health, the ring is domain, size is traffic, and databases, queues, and external calls get their own shapes. Select an app to see its tags, catalog entry, live telemetry, and links. Apps missing tags are marked **untagged**; apps with no catalog entry are marked **uncataloged**, with an **Add to catalog** button.
- **Catalog.** Add, edit, and delete business context. Domain, criticality, and owner show read-only, from tags.
- **Deep links.** `https://<catalog>/?workload=<service name>` selects that app. The workbook's **Open in catalog** links use it.

If the tags or the catalog can't be read, the graph still renders and a banner explains what's missing.

The catalog page loads on open, when its time range changes, or when you choose **Refresh**; it is not a continuously streaming dashboard. The page initially requests seven days, whereas the estate API defaults to 24 hours when no range is supplied. Recent log-query data is also distinct from Application Insights **Live Metrics**.

![Azure-hosted Estate Atlas showing the full graph and the inventory service's detail card](images/estate-atlas.png)

*The selected app's card separates Azure classification, SQL business context, and observed telemetry.*

The full API and local development setup are in the [catalog app README](../standalone-catalog-graph/README.md). To load many entries at once, post an array to the import endpoint. Existing entries are never overwritten:

```bash
curl --fail-with-body -X POST "$CATALOG_URL/api/catalog/import" -H 'Content-Type: application/json' \
  --data-binary @demo/catalog-seed.json
```

Run that command from the repository root after setting `CATALOG_URL` to the URL printed by deployment. It changes catalog data; it is not a health check.

> [!WARNING]
> The UI and API are anonymous. Anyone who can reach the URL can read the data exposed by the app and change the catalog. Turn on [App Service authentication](https://learn.microsoft.com/azure/app-service/overview-authentication-authorization) or suitable network controls before storing real data. Link validation permits only `http://` and `https://` prefixes; that is a URL-scheme restriction, not a general security guarantee.

## Apps in other resource groups

The deployment grants the catalog app's identity **Log Analytics Reader** on the platform's resource group. That covers the workspace and the tags of apps registered there. An app in another group can appear once its request telemetry reaches the shared workspace. It shows as **untagged** until the identity can read that resource. Grant **Reader** where those apps live:

```bash
export RG="<the same platform resource group used for deployment>"
export WEB_APP="<catalog web app name from the deployment>"
principal=$(az webapp identity show -g "$RG" -n "$WEB_APP" --query principalId -o tsv | tr -d '\r')
az role assignment create --assignee-object-id "$principal" --assignee-principal-type ServicePrincipal \
  --role Reader --scope "/subscriptions/<subscription id>/resourceGroups/<their resource group>"
```

People viewing the workbook need the same read access, because the workbook queries Resource Graph as them.

## Learn more

- [Query Azure Resource Graph from Log Analytics](https://learn.microsoft.com/azure/azure-monitor/logs/azure-monitor-data-explorer-proxy)
- [Azure Workbooks](https://learn.microsoft.com/azure/azure-monitor/visualize/workbooks-overview)
- [Azure Resource Graph](https://learn.microsoft.com/azure/governance/resource-graph/overview)
- [App Service authentication and authorization](https://learn.microsoft.com/azure/app-service/overview-authentication-authorization)
