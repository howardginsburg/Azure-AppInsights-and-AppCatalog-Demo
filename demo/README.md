# Observability Demo

A disposable Azure estate that makes the architecture in this repository tangible: real
Application Maps, real end-to-end transactions including database calls, a real portfolio
workbook, and a real service catalog — driven entirely by a **synthetic telemetry
simulator**, with no application services deployed.

Eight Application Insights resources, one Log Analytics workspace, three business domains,
and one console process pretending to be eight microservices. Azure cannot tell the
difference.

| | |
|---|---|
| **Time to first map** | ~10 minutes (3 to deploy, 2 to generate, 5 to ingest) |
| **Cost** | Effectively zero — see [below](#cost-and-teardown-first) |
| **Teardown** | `./teardown.sh` |

**Jump to:** [Get it running](#part-1--get-it-running) ·
[Simulator options](#simulator-options) · [Guided tour](#part-3--guided-tour) ·
[Reference](#part-4--reference)

---

# Part 1 — Get it running

## Cost and teardown, first

Eight Application Insights resources and a Log Analytics workspace cost **nothing at rest** —
Azure Monitor bills on ingestion, and a 24-hour backfill (~12,000 spans) sits inside the
workspace free grant. Live mode at the default rate adds roughly 40,000 spans/hour, still
inside the grant. Controls in place:

- `deploy.sh` sets a **1 GB/day cap** on the workspace as a cost fuse
- Everything lives in **one resource group**
- The simulator runs bounded by default; live mode is opt-in

```bash
./teardown.sh     # deletes the resource group; force-purges workspaces
```

Delete it when you are done anyway. A demo you cannot delete confidently is a demo that
quietly bills.

## Prerequisites

| Tool | Why | Check |
|---|---|---|
| **Azure CLI**, logged in with a subscription selected | Creates every resource | `az account show` |
| **.NET 10 SDK** | Builds and runs the simulator | `dotnet --version` |
| **bash** — WSL or Git Bash on Windows | `deploy.sh` / `teardown.sh` | `bash --version` |
| **Node.js** *(optional)* | Only needed if you edit the workbook | `node --version` |

You need permission to create resource groups and Application Insights resources in the
target subscription. Nothing else — no Owner, no policy exemptions.

## Step 1 — Deploy the estate

```bash
cd demo
./deploy.sh          # ~3 minutes
```

This creates the resource group, the Log Analytics workspace, 8 tagged Application Insights
resources, the daily cap, and the portfolio workbook — then writes **`demo/.env`** containing
the 8 connection strings the simulator reads.

The script is idempotent: re-running it updates in place rather than duplicating. The
workbook uses a deterministic GUID for exactly this reason.

## Step 2 — Generate history

```bash
cd simulator
dotnet run -c Release -- --backfill-hours 24
```

Takes ~2 minutes and emits ~12,000 spans across 24 hours of simulated history, including
three injected incidents you can investigate.

Then **wait about five minutes.** Backfilled telemetry needs 2–5 minutes to become
queryable, and Application Map needs a little longer to finish component discovery. This is
normal ingestion latency, not a broken deployment.

> **Why 24 hours and not a week?** Application Insights ingestion **rejects any telemetry
> older than 48 hours**. The simulator refuses more than 47 to stay clear of the edge.

## Step 3 — Leave it running during the demo *(recommended)*

```bash
dotnet run -c Release -- --backfill-hours 0 --live
```

Backfill gives you *history* to investigate. Live mode makes the estate **move while you
talk** — the map redraws, charts extend to the right, transaction search fills from the top,
and **Live Metrics works at all**, which it cannot do against back-dated data.

`--backfill-hours 0` means "add nothing to history, just start emitting now", so this is safe
to run against an estate that already has its 24 hours. Run it in a second terminal and leave
it up. Stop with Ctrl+C.

To do both in one command on a fresh estate:

```bash
dotnet run -c Release -- --backfill-hours 24 --live
```

**Running it unattended.** Live mode is bounded by `--live-minutes` and otherwise runs until
Ctrl+C. To leave it going in the background and keep the console output:

```bash
# bash
dotnet run -c Release -- --backfill-hours 0 --live-minutes 240 > ../live-simulator.log 2>&1 &
tail -f ../live-simulator.log
```

```powershell
# PowerShell — run the built dll directly so there is no wrapper process in the way
dotnet "bin\Release\net10.0\obsdemo-simulator.dll" --backfill-hours 0 --live-minutes 240 *> "..\live-simulator.log"
```

Stop it with `Stop-Process -Id <pid>` on Windows, or `kill %1` in bash.

## Step 4 — Confirm it worked

Open **Logs** on the `log-obsdemo` workspace and run:

```kusto
union AppRequests, AppDependencies, AppTraces, AppExceptions
| where TimeGenerated > ago(26h)
| summarize Rows = count(), Services = dcount(AppRoleName) by Type
```

You should see all four tables populated and 8 distinct services. If `AppRequests` is empty,
give it another two minutes before assuming anything is wrong.

| Symptom | Cause |
|---|---|
| Nothing at all, minutes later | Simulator ran before `deploy.sh` finished writing `.env`, or `.env` was not found — check the `config:` line the simulator prints |
| Data present, Application Map sparse | Progressive discovery still running. Wait, then refresh |
| Fewer than 8 services | A connection string is missing from `.env`; re-run `./deploy.sh` |
| Everything healthy and boring | Your time range is "last 30 minutes". The incidents are 4.5–18h back — see [Stop 0](#stop-0--find-the-incident-windows-first) |

## Step 5 — Tear it down

```bash
./teardown.sh
```

---

## Simulator options

| Option | Default | What it does |
|---|---|---|
| `--backfill-hours N` | `24` | Hours of history ending now. Max 47 — ingestion rejects anything older than 48h. `0` skips backfill entirely. |
| `--traces-per-hour N` | `60` | Density of the backfill. 60 over 24h is ~12,000 spans. |
| `--live` | off | After the backfill, keep emitting in real time until Ctrl+C. |
| `--live-minutes N` | unlimited | Stop live mode automatically after N minutes. |
| `--live-rate N` | `60` | Live traces per **minute**. 60 = one per second. |
| `--seed N` | `1337` | RNG seed, for reproducible runs. |
| `--dry-run` | off | Build every trace and print the full breakdown **without sending anything**. Costs nothing and needs no Azure connection beyond `.env`. |
| `--help` | | Print all of the above. |

Passing `--live-minutes` or `--live-rate` implies `--live`. Unknown flags are **rejected**
rather than silently ignored — an ignored `--hours 1` looks like it worked while quietly
running the 24-hour default.

### Useful combinations

```bash
# See exactly what would be generated, send nothing
dotnet run -c Release -- --dry-run

# Small, fast estate for a quick smoke test
dotnet run -c Release -- --backfill-hours 6 --traces-per-hour 30

# Live only, high rate, for a Live Metrics demo
dotnet run -c Release -- --backfill-hours 0 --live --live-rate 120

# Bounded live run you can walk away from
dotnet run -c Release -- --backfill-hours 0 --live-minutes 45
```

> Incidents are injected at **fixed offsets from now**: 4.5–6h ago, 10–12h ago, 17–18h ago.
> A short backfill therefore contains no failures — the simulator tells you when that
> happens and suggests `--backfill-hours 6` or more. Live mode injects its own incidents
> continuously instead, so roughly 6–8% of live traces fail.

### What the console shows you

Every run prints what is being simulated before it sends anything: the estate grouped by
domain, the three business flows with their full call paths, which incident windows fall
inside the backfill, and where the connection strings came from.

The backfill then shows a progress bar with an ETA, followed by a breakdown of traces by
flow, spans by service and by domain, and a count of backing-service calls by type
(`microsoft.sql_server`, `servicebus`, `redis`, `cosmosdb`).

Live mode prints **one line per distributed trace** as it is emitted — timestamp, flow, span
count, duration, and outcome, with the specific incident named on failures:

```
    time      flow             spans  duration  outcome
    --------  ---------------  -----  --------  -------------------------
    12:20:44  checkout            16     301ms  ok
    12:20:45  update-profile       7      43ms  ok
    12:20:46  browse-catalog       5    1939ms  FAILED  catalog SQL timeout
    ----  75 traces | 856 spans | 5 failed (6.7%) | 60/min  ----
```

This matters during a demo: the console is the ground truth for what *should* be appearing in
the portal, so you can point at a failed trace and then go find it.

---

# Part 2 — What gets deployed

| Thing | Count | Why |
|---|---|---|
| Resource group `AppInsightsDemo` | 1 | The entire blast radius, so teardown is one command |
| Log Analytics workspace `log-obsdemo` | 1 | Demonstrates the single-workspace thesis directly |
| Application Insights (workspace-based) | 8 | One per workload, tagged with domain/criticality/owner |
| Portfolio workbook | 1 | Four tabs, joins telemetry to the service catalog |

Eight workloads across three business domains, plus one deliberately **shared** platform
service consumed by two of them:

| Workload | Domain | Role |
|---|---|---|
| `retail-web` | Retail | Storefront BFF |
| `retail-api-orders` | Retail | Order management |
| `retail-api-catalog` | Retail | Product catalog |
| `pay-api-gateway` | Payments | Payment orchestration |
| `pay-worker-settlement` | Payments | Async settlement worker |
| `cust-api-profile` | Customer | Profile service |
| `cust-worker-notify` | Customer | Notification worker |
| `shared-api-inventory` | Platform | **Called by Retail and Payments** |

Three flows are generated across them:

| Flow | Share | Path |
|---|---|---|
| **checkout** | 45% | `retail-web` → `retail-api-orders` → `shared-api-inventory` → SQL → `pay-api-gateway` → *external processor* → Service Bus → `pay-worker-settlement` → SQL → `shared-api-inventory` `/api/commit` |
| **browse-catalog** | 35% | `retail-web` → `retail-api-catalog` → Redis → SQL |
| **update-profile** | 20% | `retail-web` → `cust-api-profile` → Cosmos DB → Service Bus → `cust-worker-notify` → *external email API* |

---

# Part 3 — Guided tour

A click-through tour of the estate. Roughly 30 minutes end to end. Every stop works against
telemetry that is **synthetic but structurally identical** to what a real .NET application
built with today's SDKs produces — the same OpenTelemetry semantic conventions, the same
Azure Monitor exporter, the same ingestion path.

**Before you start:** complete [Steps 1–3](#step-1--deploy-the-estate) above. Live mode is
optional, but every stop below is more convincing when the numbers are changing.

## The one-paragraph version

Eight Application Insights resources, one Log Analytics workspace, three business domains.
Every service writes to its own Application Insights resource, but because they are all
**workspace-based** and share an `OperationId`, Azure stitches them back into single
end-to-end transactions. That combination — separate resources for ownership, one workspace
for correlation — is the architecture this whole repository argues for. The rest of the tour
is watching it work.

---

## Stop 0 — Find the incident windows first

The simulator injects three incidents at fixed offsets from when you ran the backfill.
Everything interesting happens inside them, so locate them before anything else.

Open **Logs** on the `log-obsdemo` workspace and run:

```kusto
AppRequests
| where TimeGenerated > ago(26h)
| summarize Reqs=count(), Fails=countif(Success == false), P95=round(percentile(DurationMs,95),0)
    by bin(TimeGenerated, 1h), AppRoleName
| where Fails > 0 or P95 > 1500
| order by TimeGenerated asc
```

You will see three clusters:

| Incident | Roughly | Signature |
|---|---|---|
| Catalog SQL timeouts | 17–18h ago | `retail-api-catalog` failing, P95 climbing |
| Payment latency | 10–12h ago | `pay-api-gateway` P95 ≈ 2–3s, **zero failures** |
| Inventory failures | 4.5–6h ago | `shared-api-inventory` failing in **two domains** |

Write down the actual timestamps. Several stops below ask you to set the time range to one of
these windows, and the default "last 30 minutes" will show you a perfectly healthy, perfectly
boring system.

> The payment incident has **zero failures**. That is deliberate. A service can be entirely
> "up" by availability metrics and still be ruining the customer experience. If your alerting
> only watches failure rate, you would never know this happened.

---

## Stop 1 — Application Map, and what "shared" really costs

Open **ai-retail-web** → **Application Map**.

Give it a moment; cross-component maps use progressive discovery, so nodes arrive in waves.
This is expected behaviour, not a slow portal.

What to notice:

1. **The map spans resources you did not open.** You opened `retail-web`, but the map draws
   `retail-api-orders`, `pay-api-gateway`, `shared-api-inventory`, and more. Each is a
   separate Application Insights resource. The map is assembled from telemetry, not from
   configuration — role name is what stitches it.
2. **Databases and queues are nodes too**, because dependency spans carry the OpenTelemetry
   `db.*` and `messaging.*` attributes that the exporter maps to typed dependencies.
3. **Two nodes have no server side**: `api.globalpayments-example.com` and
   `api.emailprovider-example.com`. They are deliberately uninstrumented third parties. The
   map is showing you exactly where your instrumentation stops — which is one of the most
   useful things it does.

Now set the time range to the **inventory incident window** and look again.

`shared-api-inventory` turns red — and so do edges in **both Retail and Payments**. That is
the point of the whole estate design. Inventory lives in the Platform domain, but it is
called by `retail-api-orders` during checkout *and* by `pay-worker-settlement` when it
commits stock after payment clears. One service degrades; two business domains bleed.

This is the argument against making "domain" a hard boundary. If each domain owned an
isolated workspace, this single picture would be three disconnected pictures, and the on-call
engineer in Payments would have no idea why their worker was failing.

---

## Stop 2 — One transaction, five resources

From the map, click `shared-api-inventory` → **Investigate failures** → pick a failed
operation. Or run this and click any `OperationId`:

```kusto
AppRequests
| where TimeGenerated > ago(26h) and AppRoleName == "retail-api-orders" and Success == false
| project TimeGenerated, OperationId, Name, ResultCode
| take 20
```

You get the full waterfall: `retail-web` → `retail-api-orders` → `shared-api-inventory` →
SQL, then the payments leg, the Service Bus hop, and the settlement worker.

### "Wait — is the same telemetry being sent to multiple resources?"

No. This is the question everyone asks at this stop, and it is worth answering precisely,
because the answer explains how distributed tracing actually works.

Run this to see one trace laid out with its owning resource:

```kusto
let op = toscalar(
    AppRequests
    | where TimeGenerated > ago(26h) and AppRoleName == "shared-api-inventory"
    | take 1 | project OperationId);
union AppRequests, AppDependencies
| where TimeGenerated > ago(26h) and OperationId == op
| extend Resource = tostring(split(_ResourceId, "/")[-1])
| project TimeGenerated, AppRoleName, Resource, Table = Type, Name, Id, ParentId
| order by TimeGenerated asc
```

Two things are true at once:

- **Each span exists exactly once, in exactly one resource.** A given service's spans go to
  that service's Application Insights resource and nowhere else. There is no duplication.
- **The trace is assembled across all of them** at query time, by shared `OperationId`.

So a 13-span transaction spanning five resources looks enormously detailed no matter which
resource you opened it from. `shared-api-inventory` contributes only two of those spans — its
own request and its SQL call — but because it sits in the middle of the busiest flow, opening
it shows you everything around it.

**The one thing that genuinely looks like a duplicate:** `POST /api/reserve` appears twice.
Once as a *dependency* in `retail-api-orders`, once as a *request* in `shared-api-inventory`.
Check the `Id` and `ParentId` columns — the caller's dependency span is the **parent** of the
callee's request span. They are two different spans describing the two ends of one network
call: the client's view (including connection and transit time) and the server's view (time
actually spent handling it). The gap between their durations is your network and queuing
overhead. This is normal, correct, and useful — but it does mean you must never
`union AppRequests, AppDependencies` and call the result "number of calls."

---

## Stop 3 — Drilling from a failure to a root cause

Set the range to the **catalog SQL timeout** window. Open **ai-retail-api-catalog** →
**Failures** → **Dependencies** tab.

You will find failed SQL dependencies with `ResultCode` `-2` — SQL Server's timeout code. The
deadlocks in the inventory incident carry `1205`. These are real SQL Server error codes, not
invented ones, so the muscle memory you build here transfers.

Click into an operation and note that the exception on the server span
(`Contoso.Catalog.QueryTimeoutException`) and the failing SQL dependency underneath it are in
the same trace. That descent — user-facing failure → responsible service → exact failing
statement — is the payoff for correlated telemetry.

> **A detail worth knowing:** SQL dependencies have an empty `ResultCode` when they succeed.
> That is not a gap in the demo; the Azure Monitor exporter simply does not populate it for
> successful database spans. Do not build alerts that assume it is always present.

---

## Stop 4 — Latency without failure

Set the range to the **payment latency** window. Open **ai-pay-api-gateway** →
**Performance**.

`POST /api/authorize` sits at roughly 2–3 seconds at P95. Drill in and the time is
overwhelmingly spent in the external `POST /v2/charges` call to the uninstrumented payment
processor.

This is the case where you can see *that* you are slow and *where*, but not *why* — because
the slow thing is somebody else's system. The honest conclusion is "open a ticket with the
provider", and the map told you that in one click. Note also how the latency propagates
upstream into `retail-api-orders` and `retail-web`: the customer feels a slow checkout, and
three services look guilty, but only one is.

---

## Stop 5 — Logs, correlated to traces

Application Insights is not only spans. Run:

```kusto
AppTraces
| where TimeGenerated > ago(26h) and SeverityLevel >= 2
| project TimeGenerated, AppRoleName, SeverityLevel, Message, OperationId, ParentId
| order by TimeGenerated desc
| take 50
```

Every row carries `OperationId` and `ParentId`, so a log line drops you straight into the
transaction that produced it. Severity maps as `1` = Information, `2` = Warning, `3` = Error.

Look for this pair during the inventory incident:

- `shared-api-inventory` logs an **Error**: deadlock on `dbo.StockLevels`
- `retail-api-orders` logs a **Warning**: abandoning checkout for the order

Different services, different resources, same trace, one story. Getting this for free is the
reason to use `ILogger` inside instrumented code rather than writing to stdout.

Then look for `pay-worker-settlement` logging *"Settled payment but could not commit stock"*.
That failure happens **after** the customer already received a `200`. Nobody is watching a
screen when it happens. This is the class of bug that async workers exist to create, and the
reason worker services need their own alerting rather than inheriting the front end's.

---

## Stop 6 — One query, eight resources, no joins

```kusto
AppDependencies
| where TimeGenerated > ago(26h)
| summarize Calls=count(), Failures=countif(Success == false),
            P95ms=round(percentile(DurationMs,95),0)
    by Caller = AppRoleName, DependencyType, Target
| extend FailureRatePct = round(100.0 * Failures / Calls, 2)
| order by Calls desc
```

Notice what is **absent**: no `app()`, no `workspace()`, no `union` across resources. Because
every Application Insights resource here is workspace-based and points at the same workspace,
one table already contains all eight services.

Had these been classic (non-workspace-based) resources, or spread across several workspaces,
this query would need an explicit cross-resource `union` and would be subject to the
100-resource limit. This single query is the strongest practical argument in the whole
architecture.

Now find every consumer of the shared service:

```kusto
AppDependencies
| where TimeGenerated > ago(26h) and Target has "shared-api-inventory"
| summarize Calls=count(), Failures=countif(Success == false) by Caller = AppRoleName
```

Two callers, in two different domains. Before you change that service's API, this is your
blast-radius list.

---

## Stop 7 — The portfolio workbook

**Monitor** → **Workbooks** → **Application Portfolio - Observability Demo**.

Five tabs:

1. **Portfolio** — one row per application: health, availability against its own SLO, request
   volume, P95, owner, business owner, and live links to the app, docs, runbook, and repo.
   Availability is heat-mapped, so a red cell is a real problem.
2. **Estate map** — see Stop 7a.
3. **Domain rollup** — the same health aggregated by business domain. This is the taxonomy
   paying off: because `domain` is a *tag*, an executive-facing rollup is one `by Domain`.
4. **Cross-resource** — every dependency across all eight services in a single result set.
5. **Metadata quality** — see Stop 8.

The important thing here is the join. Azure knows request rates, failure rates, and latency.
Azure has no idea what a service is *for*, who owns it, what its SLO is, or where its runbook
lives. That half comes from `catalog/catalog.json`, and the workbook joins the two on the
workload key.

The Portfolio tab inlines the catalog as a KQL `datatable`, so it only changes when someone
re-runs `build-workbook.mjs`. The **Estate map** tab instead joins the live `AppCatalog`
reference table that `deploy.sh` publishes — edit the catalog, re-run the sync, and the map
updates with no rebuild. See [Keeping the catalog current](#keeping-the-catalog-current).

---

## Stop 7a — The estate map

Application Map is scoped to one Application Insights resource. This tab is the same idea for
the **whole estate**, in one picture.

**What to point at, in order:**

1. **`Inventory Service` sits in the middle with two inbound edges** — one from Retail
   (`retail-api-orders`), one from Payments (`pay-worker-settlement`). That single node is the
   argument for the whole taxonomy: a shared service means domain is a *reporting tag*, not a
   containment boundary. When Inventory degrades, the blast radius crosses domains, and the
   map shows it before anyone files a ticket.
2. **Node colour is health, edge thickness is call volume.** During the inventory-failure
   window, Inventory and both its callers go amber together — a visual blast radius.
3. **Hover any node** for display name, domain, owner, tier, call and failure counts, P95, and
   the app URL.
4. **Click a node** and the grid below loads its catalog entry, with links to the app, docs,
   runbook and repo. That is the portfolio and the topology joined in one gesture.
5. **The honeycomb below** drops the edges and groups every service by domain, colour-coded
   against each service's *own* SLO. The map answers "what talks to what"; the honeycomb
   answers "how is each domain doing".

**How the edges are derived** — this matters, because it is the difference between a real map
and a drawing. A caller emits a dependency with `Id = X`; the callee's request carries
`ParentId = X`. Joining on that yields a true service-to-service edge. Using the dependency
`Target` alone would give you `service -> hostname`, which does not resolve to a node and
fragments the map.

Two corrections were needed to make it honest, both worth knowing if you adapt the query
(`queries/estate-map.kql`):

- **Orphan dependencies create phantom duplicate nodes.** Some dependencies have no matching
  request — sampling, or the callee's telemetry falling outside the time window. Those render
  as a second node for a service that already exists. For HTTP the fix is to resolve the
  target hostname back to a known role name.
- **Do not apply that hostname flattening to data stores.** Doing so collapsed four distinct
  databases into a single node, which made the map say something false. Only HTTP targets get
  flattened; data stores keep the database name.

**Honest limits of the workbook graph:**

- A node shows **one tooltip string per content slot**. The workaround used here is to compose
  the entire hover card as a `Hover` column in KQL and reference it as `["Hover"]`.
- Force-directed layout (`graphOrientation: 2`) re-seeds every refresh, so the picture moves
  around between loads. This tab defaults to **flow, left-to-right**, which is deterministic
  and demos better. The layout toggle is still available if you want to show the force view.
- **Edges have no hover** and no drill-in — only the static label.
- If you need richer interaction (hover detail on edges, click-through context menus), the
  Node Graph panel in Azure Managed Grafana is the better tool. It reads the same Log
  Analytics data; it just needs separate `nodes` and `edges` result sets.

---

## Keeping the catalog current

The catalog is published to Log Analytics in two forms, because they answer different
questions. `sync-catalog.mjs` writes both:

| | `AppCatalog` (saved function) | `AppCatalog_CL` (custom table) |
|---|---|---|
| What it is | ARM metadata — a saved function whose body is a `datatable()` | Log data, via the Logs Ingestion API |
| Retention | **None. Never ages out.** | Subject to retention (730 days interactive, max) |
| Answers | What is true *now* | What was true *then* |
| Deletion | Implicit — the row is just absent after a replace | Explicit tombstone row |
| Use it for | Every join. This is the reference table. | History and audit |

```bash
node sync-catalog.mjs --target both        # after editing catalog/catalog.json
node sync-catalog.mjs --target both --full # rewrite everything, skip delta detection
```

It is source-agnostic — it consumes a JSON array, so pulling from SQL Server is a pipe:

```bash
sqlcmd -S <server> -d <db> -G -C -h -1 -W \
  -Q "SET NOCOUNT ON; SELECT * FROM dbo.ServiceCatalog FOR JSON PATH" > rows.json
node sync-catalog.mjs --from rows.json --target both
```

Point a timer-triggered Function or a nightly pipeline at that and the catalog stays current
on its own.

### Why the table needs two extra columns

A custom table is **append-only** — no `UPDATE`, no `DELETE`. So "the catalog" is not the set
of rows, it is *the newest row per workload*. Two bookkeeping columns make that work:

- **`isActive`** — `false` marks a tombstone. This is the one that is easy to miss: without
  it, deleting a service from the source is invisible, because `arg_max()` keeps returning
  its last known row forever and the retired service haunts the portfolio permanently. The
  sync detects disappearances and writes an explicit tombstone.
- **`rowHash`** — a content hash. Only changed rows are written, so the table is a real
  change log rather than eight identical rows every night. Re-running the sync with no source
  changes writes nothing at all.

Which makes the canonical query:

```kusto
AppCatalog_CL
| summarize arg_max(TimeGenerated, *) by workload
| where isActive
```

`queries/catalog-current.kql` has this plus point-in-time and change-history variants.

> **Gotcha worth knowing.** Adding a column to a custom table that already exists does not
> work. The `PUT` succeeds, ARM reports the new column, `getschema` lists it — and the
> ingestion pipeline silently drops that field on every subsequent row, with no error
> anywhere. You have to delete the table and recreate it with the full schema. Deleting a
> table is a schema operation; it does not remove rows already ingested.

---

## Stop 8 — Where the two halves disagree

The **Metadata quality** tab answers a question most estates cannot: *does our inventory
match reality?*

- 🔴 **Emitting telemetry but not in the catalog** — a service nobody registered. The classic
  shadow-IT finding.
- 🟠 **In the catalog but emitting nothing** — either decommissioned and never removed, or
  broken instrumentation. Both worth knowing.
- 🟢 **Agreeing** — the goal.

To watch it work, add a fake entry to `catalog.json`, re-run `build-workbook.mjs` and
`deploy.sh`, and it will appear as orange within a minute.

This drift check is the difference between a portfolio that is trusted and one that quietly
rots. Run it on a schedule.

---

## Stop 9 — Watch it happen live

Everything so far has been **forensic**: history, already written, already ingested. The last
stop is the opposite — telemetry arriving *while people are looking at the screen*.

If you have not already, start live mode in a second terminal:

```bash
cd simulator && dotnet run -c Release -- --backfill-hours 0 --live
```

One trace per second by default; use `--live-rate 120` if you want the charts to move faster.

The console prints one line per distributed trace, which is the point — it is the ground
truth for what should be appearing in the portal. Watch a `FAILED` line go past, then go find
that exact trace in the portal.

### What to show, in order

**1. Live Metrics — the one thing backfill cannot do.**
Open any resource → **Live Metrics**. Sub-second latency, no ingestion delay, no sampling.
This blade only works against telemetry timestamped *now*, which is precisely why the
backfilled estate showed nothing here.

> Live Metrics **cannot split by cloud role name**, so it shows one service at a time. That is
> a genuine product limitation and a good reason not to build a demo around it — but it is
> excellent for ten seconds of "yes, this is happening right now".

**2. Application Map with a live time range.**
Set the time range to **Last 30 minutes** and leave the map open. Failed edges appear and
clear as incidents come and go, because live mode injects incidents continuously (~25% of
traces run in a degraded window; ~6–8% actually fail) rather than in fixed windows.

**3. A chart that grows.**
Any metric chart on **Last 30 minutes** with auto-refresh on. The right-hand edge advances
while you talk. Nothing sells "this is a live system" faster.

**4. Transaction search, newest first.**
Sort by timestamp descending and refresh. New transactions appear continuously, and you can
open one that was emitted seconds ago.

### Two honest caveats

| | |
|---|---|
| **Log data is still 1–2 minutes behind** | Live Metrics is instant, but `AppRequests` and friends go through normal ingestion. Do not promise instant results from a KQL query. |
| **Pre-aggregated metrics only work in live mode** | Metrics ingestion rejects backdating beyond ~20 minutes, so the backfill produced none. This is exactly why the portfolio workbook queries the **log tables** rather than metrics — and live mode is your chance to show metric-based charts working. |

---

# Part 4 — Reference

## What is synthetic, and what is not

Being precise about this matters, because the demo's value depends on it.

**Real:** the OpenTelemetry SDK, the Azure Monitor exporter, the semantic conventions, the
ingestion pipeline, the storage schema, and every query, map, and workbook you just used.
Azure cannot tell this estate from a real one.

**Synthetic:** the events themselves. No service is deployed. There is no SQL Server, no
Redis, no Cosmos DB, no Service Bus namespace. One console process emits correlated spans
with back-dated timestamps as if it were eight services.

## How the simulation works

One console process emits correlated OpenTelemetry spans, using one `ActivitySource` and
`TracerProvider` per simulated service, each pointed at that service's own connection string.
Parent span context is threaded down the tree explicitly, so traces stitch across services and
therefore across Application Insights resources.

**Each span is sent to exactly one resource.** Nothing is duplicated — see
[Stop 2](#wait--is-the-same-telemetry-being-sent-to-multiple-resources).

### Fidelity

The goal is telemetry indistinguishable from a real .NET app built with today's SDKs, so
attributes follow the **current stable** OpenTelemetry semantic conventions and span names
follow what the real instrumentation libraries actually emit (`ServiceBusSender.Send`, not the
generic `"{queue} send"`). Two deliberate divergences, both commented in `Flows.cs`:

- **Cosmos DB** emits `db.system.name = "cosmosdb"`, not the registry's `azure.cosmosdb`,
  because that is what the shipping SDK produces. The spec value would render a
  `DependencyType` that appears in no real application.
- **Queue correlation is parent-child.** The real `Azure.Messaging.ServiceBus` SDK uses span
  links and starts a new trace, so producer and consumer appear as *separate* traces. This
  models the outcome you get after following the manual context-propagation guidance in
  `04-csharp-instrumentation.md`, which is what you want for end-to-end visibility.

**One thing to know before you copy anything:** the simulator is a **telemetry generator, not
an instrumentation reference**. To instrument a real application, read
`04-csharp-instrumentation.md`.

For the internals — the build-then-emit model, per-service pipeline isolation, how back-dating
works for traces and logs, and the full attribute-to-table mapping — see
[`simulator/ARCHITECTURE.md`](simulator/ARCHITECTURE.md).

## Layout

```
demo/
  README.md               This file — setup, options, and the guided tour
  deploy.sh               RG + workspace + 8 App Insights + catalog table + workbook
  teardown.sh             Single-command cleanup
  build-workbook.mjs      Generates workbook-portfolio.json (run after editing tiles)
  sync-catalog.mjs        Publishes the catalog to Log Analytics (function + table)
  workbook-portfolio.json ARM template (generated)
  catalog/catalog.json    Service catalog — the hand-authored source of truth
  queries/*.kql           Cross-resource portfolio queries
    estate-map.kql        Holistic dependency graph (nodes + edges) for the Estate map tab
    catalog-current.kql   Current state, point-in-time, and change history
  simulator/              .NET console app: topology, flows, scenarios
    ARCHITECTURE.md       How the simulator is built and how data flows through it
```

### Editing the workbook

The workbook is generated, not hand-edited — an ARM workbook carries its entire definition as
an escaped JSON *string*, which is miserable to maintain by hand:

```bash
node build-workbook.mjs && ./deploy.sh
```

The workbook resource name is a **deterministic** GUID, so redeploying updates it in place
instead of creating duplicates.

The estate map's KQL lives in `queries/estate-map.kql` rather than inside the generator, so
you can paste it straight into the Logs blade to iterate on it. `build-workbook.mjs` reads
that file at build time — there is one copy, not two.

## Gotchas worth carrying home

| Gotcha | Why it matters |
|---|---|
| **The exporter samples by default.** `AzureMonitorExporterOptions.TracesPerSecond` defaults to `5` in exporter 1.8.x, and it installs a sampler that overrides one set *earlier* on the builder. | An app upgrading its exporter can silently start dropping telemetry. Set `TracesPerSecond = null` and call `SetSampler()` **after** `AddAzureMonitorTraceExporter`. |
| Ingestion rejects telemetry older than **48 hours**. | Backfill is capped; the simulator refuses more than 47h. |
| Pre-aggregated **metrics** accept only ~20 minutes of backdating. | Backfilled dashboards must query log tables, not metrics. Every tile in the workbook does. |
| Cross-resource queries cap at **100 resources**. | Eight is fine. Plan for it at scale. |
| Live Metrics cannot split by role name. | Do not build a multi-service demo around it. |
| `AppDependencies.Name` gets a `SQL: ` prefix for SQL dependencies. | Added by the exporter path. Account for it when matching on names. |
| There is no `ForceFlush` on `ILoggerFactory`. | Disposing it is the only way to flush logs — so dispose only at shutdown, or you silently kill logging for everything after. |
| A dependency whose callee request is missing renders as a **duplicate node** on a topology graph. | Resolve HTTP targets back to a known role name — but only HTTP, or you collapse distinct databases into one node and the map starts lying. |
| The workbook graph allows **one tooltip string per content slot**. | Compose the whole hover card as a column in KQL and reference it as `["ColumnName"]`. |
| Force-directed graph layout re-seeds on every refresh. | Use `graphOrientation: 1` (flow) for anything you intend to demo or screenshot. |
| Workbook `GET` returns an empty `serializedData`. | Append `&canFetchContent=true` to the ARM URL, or you will think your deployment shipped an empty workbook. |

## Known environment quirks

| Quirk | Workaround |
|---|---|
| `az log-analytics` extension can fail with `No module named 'pkg_resources'` | Query via `az rest --method post --url "https://api.loganalytics.io/v1/workspaces/<guid>/query" --resource "https://api.loganalytics.io" --body "@file.json"` |
| `teardown.sh` confirmation fails when piped from PowerShell | CRLF. Run it interactively, or pipe from inside bash: `bash -c 'printf "AppInsightsDemo\n" \| ./teardown.sh'` |
| `&` in a URL is eaten by cmd when calling `az rest` on Windows | Use `Invoke-RestMethod` with a bearer token from `az account get-access-token` |
| Non-ASCII in ARM string parameters can be mangled by the CLI on Windows | Keep ARM-level strings ASCII; text inside `serializedData` is unaffected |
| `dotnet run --no-build` fails after only a Debug build | Match the configuration: `dotnet build -c Release` first |

## Not in scope

Fabric integration · availability tests and SLO alert rules · real deployed services ·
prod/non-prod duplication · CI/CD wiring.
