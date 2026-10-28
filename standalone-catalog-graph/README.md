# Estate Atlas: the catalog app

A standalone portfolio and dependency explorer that keeps the business context tags don't hold. Overview, domain/application/resource graph lenses, dependency impact, and actual transaction timelines share one observation window and data model. See [Catalog and workbook](../docs/03-catalog-and-workbook.md#the-catalog-app) for measurement definitions and limits. This page covers its API and development.

## How it works

`/api/portfolio` combines three sources. In Azure, the backend reads them with its system-assigned managed identity, without a SQL password. Locally it uses the developer credential described below. Neither identity authenticates browser users: the UI and API are anonymous until you protect them.

| Source | What it provides | How it's read |
|---|---|---|
| Log Analytics | Apps, dependencies, calls, failures, P95 | [`server/estate.kql`](server/estate.kql), the topology query shared with the workbook, through the Log Analytics query API |
| Tags on each Application Insights resource | `domain`, `criticality`, `owner` | Azure Resource Graph, for the components linked to the workspace |
| Azure SQL `Catalog` table | Business owner, SLO, on-call, description, links | Microsoft Entra authentication, over a private endpoint |

The `workload` column joins catalog entries to the graph. It holds the effective `AppRoleName`: `OTEL_SERVICE_NAME`, or `<namespace>.<name>` when `service.namespace` is set. Keep that value unique within the workspace and use [separate platform views per environment](../docs/01-topology.md#one-environment-per-deployment). Tags are matched by resource ID instead, through `_ResourceId` on every telemetry row.

If the tags or the catalog can't be read, the graph can still render from telemetry alone, and the response carries a warning that the page shows as a banner. Coverage denominators are marked unavailable when registration data cannot be read. Telemetry-query/partial-result failures do not publish invented healthy totals.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness, which settings are present, and the Node.js version |
| `GET` | `/api/estate?rangeHours=N` | The graph: telemetry, tags, and catalog, joined. `N` is 1 to 720; default 24. The UI explicitly requests seven days initially |
| `GET` | `/api/portfolio?rangeHours=N&end=<ISO timestamp>` | Apps, exact targets/connections, domain/owner measures, previous-period measures, trends, coverage, and hosting context. Default seven days; `end` defaults to now |
| `GET` | `/api/transactions?app=<role>&mode=failed&rangeHours=N&end=<ISO timestamp>` | Up to 50 failed request/processing examples; `mode=slow` sorts observed examples by duration. Returns an explicit truncation flag |
| `GET` | `/api/transactions/:operationId?rangeHours=N&end=<ISO timestamp>` | Observed W3C transaction spans, exceptions, and warning/error logs. Uses bounded results and reports incomplete/truncated context |
| `GET` | `/api/catalog` | All catalog entries |
| `GET` | `/api/catalog/:id` | One entry |
| `POST` | `/api/catalog` | Create an entry |
| `PUT` | `/api/catalog/:id` | Update an entry |
| `DELETE` | `/api/catalog/:id` | Delete an entry |
| `POST` | `/api/catalog/import` | Insert an array of entries. Existing workloads are skipped, never overwritten |

Entries need `workload` and `displayName`. Links must be `http` or `https`. The API is anonymous; see the [warning](../docs/03-catalog-and-workbook.md#the-catalog-app) before storing real data.

The portfolio response's window anchors all comparisons. Pass its exact `end` and `hours` to transaction queries rather than recomputing now on the client. `generatedAt` is query completion, not the last telemetry event. Invalid windows/selectors return **400**; partial Log Analytics responses fail explicitly rather than publish incomplete healthy totals.

The `slo` field is now a validated finite percentage from 0 to 100 for observed request/processing success. The separate graph/workbook failure-rate colors are unchanged. Review legacy non-demo target meanings before using the comparison. No manual latency target, hosting-resource list, or metadata review date is stored.

### Create, update, and import

These are **writes**, not verification commands. Run the Bash examples from the repository root, against a synthetic-data deployment, after setting:

```bash
export CATALOG_URL="https://<catalog-web-app>.azurewebsites.net"
```

Create a minimal entry for an app you registered:

```bash
curl --fail-with-body -i -X POST "$CATALOG_URL/api/catalog" \
  -H 'Content-Type: application/json' \
  --data '{"workload":"orders-api","displayName":"Orders API"}'
```

The response is HTTP **201** with the full catalog row, including a server-assigned GUID `id`. The ID is not the workload name; use it for the `/:id` routes. `GET /api/catalog` also returns those IDs. The payload contract is [`CatalogInput`](common/shared.ts), and [`catalogInput.ts`](server/catalogInput.ts) defines validation and length limits.

`PUT` replaces all writable fields; it is **not a partial patch**. Omitted text fields become empty strings, and an omitted `isActive` defaults to `true`. Read and preserve fields you want to keep. This example deliberately writes only the shown values and resets the other optional fields:

```bash
curl --fail-with-body -X PUT "$CATALOG_URL/api/catalog/<id-from-create-response>" \
  -H 'Content-Type: application/json' \
  --data '{"workload":"orders-api","displayName":"Orders API","slo":"99.9%"}'
```

For bulk inserts, use the existing [`demo/catalog-seed.json`](../demo/catalog-seed.json) as the array-format example:

```bash
curl --fail-with-body -X POST "$CATALOG_URL/api/catalog/import" \
  -H 'Content-Type: application/json' --data-binary @demo/catalog-seed.json
```

Import returns `inserted`, `skipped`, and `total`. Existing workloads, including duplicates in the input, are skipped rather than updated; re-importing will not overwrite edits. Classification tags are not writable catalog fields.

Validation errors return **400**, unknown IDs return **404**, and duplicate workloads on create/update return **409**. Catalog-operation errors use an `error` message in the JSON body; SQL or other backend failures return **500**. A successful `/api/health` response does not test those backend operations.

## Settings

[`infra/main.bicep`](../infra/main.bicep) sets these on the web app. For local development, copy [`.env.example`](.env.example) to `.env`.

| Setting | Value |
|---|---|
| `LA_WORKSPACE_ID` | Workspace ID (GUID), for queries |
| `LA_WORKSPACE_RESOURCE_ID` | Workspace resource ID, to find the Application Insights resources linked to it |
| `SQL_SERVER`, `SQL_DATABASE` | The catalog database |
| `LA_API_HOST`, `ARM_HOST` | Optional. Endpoints for sovereign clouds |

The app creates the `Catalog` table on startup if it doesn't exist. Its identity is the database's Microsoft Entra admin, so there's no manual database step in the default deployment. This broad permission simplifies the starter; review least privilege before adopting it for production.

## Deployment

`./deploy.sh` at the repository root builds this app on your machine, through your npm registry. Vite bundles the frontend into `dist/public`, and the server, with every package it imports, into `dist-server/server/index.js`. Those, `package.json`, and `server/estate.kql` are the whole package: a few files and no `node_modules`. App Service mounts the zip read-only (`WEBSITE_RUN_FROM_PACKAGE=1`) and runs `node --enable-source-maps dist-server/server/index.js`. App Service doesn't build anything or install packages.

`dependencies` lists the packages the server imports, and `devDependencies` lists build tools and the browser libraries, React and Cytoscape.js. Vite bundles both kinds, so the split documents intent rather than changing the package.

### Node.js version

`engines.node` in [`package.json`](package.json) is the single source for the supported runtime range, including its patch floor:

- Bicep takes the major version from it for App Service (`NODE|24-lts`).
- npm refuses to install or build on a version outside the range (`engine-strict` in [`.npmrc`](.npmrc)).
- The server refuses to start outside the range.

App Service's LTS runtime setting selects a major version, not a guaranteed patch level. After deploying, check that `nodeVersion` from `/api/health` meets the manifest's range. Updating npm packages does not update the platform's Node runtime.

## Local development

The default laptop path supports **graph development** against Azure telemetry. Full catalog editing also needs private network/DNS reachability to SQL (for example through an approved VPN) **and** SQL authorization for your developer identity. `az login` alone supplies neither private connectivity nor a database grant; the default deployment grants the web app identity, not you.

Start in Bash at the repository root:

```bash
cd standalone-catalog-graph
az login
az account set --subscription "<subscription-name-or-id>"
npm install
cp .env.example .env
```

Fill in the two workspace settings using the [environment template](.env.example). Their resource ID and GUID are different values; use the template's comments. Leave SQL settings empty for graph-only development, or supply them only when you have connectivity and permission. Then, from this same catalog directory:

```bash
npm run dev
```

Open `http://localhost:5173`; Vite proxies `/api` to Express on port 8080. The API loads the local environment file. `DefaultAzureCredential` can use your Azure CLI login, but environment credentials or other supported developer credentials may take precedence. You need read/query access to the workspace and read access to the Application Insights resources.

An unavailable SQL catalog produces a warning banner, not an empty healthy catalog; the telemetry graph can still render. Changes to time range or **Refresh** run new queries; the page does not stream updates automatically.

From the catalog directory:

```bash
npm test                # node:test unit tests
npm run typecheck
npm run build           # type-checks, then builds dist/public and dist-server
```

## Layout

```text
common/shared.ts         Types shared by the server and the browser
common/portfolio.ts      Portfolio, graph, observation, and transaction contracts/measure helpers
server/
  index.ts               Express: static files and the JSON API
  estate.kql             Topology query, shared with the workbook
  estate.ts              Runs the query and joins tags and catalog entries into the graph
  portfolio.ts           Reconciles observations, registrations, business context, and host identity
  portfolioQueries.ts    Fixed-window aggregation, trends, resource metadata, and bounded trace queries
  logAnalytics.ts        Log Analytics query API client
  resourceGraph.ts       Reads tags from Azure Resource Graph
  catalogDb.ts           Catalog table: schema on startup, CRUD, import
  catalogInput.ts        Request validation
  credential.ts          The single DefaultAzureCredential
  runtime.ts             Node.js version check at startup
src/
  App.tsx                Page shell, graph controls, and the selected-app card
  EstateGraph.tsx        Cytoscape.js graph
  graphModel.ts          Domain/resource projections and cycle-safe impact/trace highlighting
  PortfolioOverview.tsx Portfolio summaries, attention list, and coverage
  TransactionPanel.tsx  Individual spans, durations/outcomes, and correlated events
  CatalogManager.tsx     Catalog table and form
  colors.ts              Domain colors, assigned from whatever domains the tags contain
test/                    Unit tests
vite.config.ts           Frontend build and the dev server's /api proxy
vite.server.config.ts    Server bundle
```
