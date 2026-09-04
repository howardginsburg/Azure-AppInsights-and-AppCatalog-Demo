# 09 — Verification Log

> This document records the verification pass of every substantive claim in this architecture against Microsoft's published documentation, the corrections that resulted, and the claims that remain lower-confidence. It exists so a reader can audit the reasoning rather than take it on trust.

**Verification date:** documentation as published at time of review. Azure Monitor changes frequently — re-verify anything marked ⚠️ before acting on it.

---

## Corrections made during verification

These are places where the original draft was **wrong or materially overstated**, and has been changed.

| # | Original claim | Documented position | Where fixed |
|---|---|---|---|
| 1 | "Start from one Log Analytics workspace **per region per environment tier**" | *"Your design should always start with a single workspace... use the fewest number of workspaces to meet your requirements."* Region is **not** an automatic split criterion — use a single workspace across regions unless a geography requirement exists | [01 P4](./01-architecture-principles.md), [02](./02-resource-topology.md), [README](./README.md) |
| 2 | "New region → new workspace, automatically" | Cross-region egress is *"usually minor"*, and data sent via **Azure diagnostic settings incurs no egress charge at all**. The real region drivers are residency, sovereignty, and deliberate resilience | [02 — guardrails](./02-resource-topology.md) |
| 3 | Cross-resource KQL sample used `app('ai-checkout-prod')` | `app()` is documented for **classic** Application Insights resources. Workspace-based resources use `workspace()`, or query the workspace tables directly | [04 — Sample 3](./04-csharp-instrumentation.md) |
| 4 | "Subject to hard limits" (unquantified) | A single query may include at most **100** workspaces or classic Application Insights resources | [02](./02-resource-topology.md), [06](./06-application-portfolio.md) |
| 5 | Query-pack functions presented as unconditionally reusable | Query-pack functions used for cross-resource scoping **cannot be used in log search alert rules**; cross-resource queries also do not support parameterized functions | [06](./06-application-portfolio.md) |
| 6 | Prod/non-prod treated as an automatic **workspace** split | Environment separation is mandatory at the **Application Insights** level. At the workspace level it is optional and must be justified by access control or retention | [01 P3/P4](./01-architecture-principles.md), [02](./02-resource-topology.md) |
| 7 | Workspace split criteria list was ad-hoc | Reconciled to the documented criteria, adding **Microsoft Entra tenants**, **data ownership**, **commitment tiers**, and **legacy agent limitations**, which were missing | [02](./02-resource-topology.md) |
| 8 | Retention differences implied a workspace split | Retention is configurable **per table**. A split is justified only when the **same table** needs different retention for different sources | [01 P4](./01-architecture-principles.md), [02](./02-resource-topology.md) |

---

## Claims verified as correct

### Resource topology

| Claim | Status |
|---|---|
| One Application Insights resource per workload per environment | ✅ Well-Architected guidance states one resource per workload per environment |
| Send different development stages to separate resources with separate connection strings | ✅ Explicit |
| Business domain is a label, not a resource boundary | ✅ Consistent with the documented "share a single resource" conditions, which are about team, deployment, and RBAC — not business domain |
| Colocate Application Insights with its Log Analytics workspace | ✅ Well-Architected reliability guidance |
| Classic Application Insights is retired; all resources must be workspace-based | ✅ |
| Consolidating resources does **not** migrate historical telemetry | ✅ Explicit — keep the old resource until the new one has enough history |
| Cross-subscription workspace linkage needs `Microsoft.OperationalInsights/workspaces/sharedKeys/action` | ✅ |
| No performance penalty from data volume in a workspace | ✅ Explicit |

### The documented "single Application Insights resource" conditions

All six conditions in [02](./02-resource-topology.md) are taken directly from documentation: deployed together / same team · centralized KPIs with role-name segmentation · no differing RBAC needs · identical alert, export, and quota management · acceptable that one API key reads all components (10-key limit) · same smart detection and work-item settings. ✅

### Instrumentation

| Claim | Status |
|---|---|
| `Azure.Monitor.OpenTelemetry.AspNetCore` + `AddOpenTelemetry().UseAzureMonitor()` | ✅ |
| Distro bundles ASP.NET Core, HttpClient, **SqlClient**, Azure SDK, and `ILogger` | ✅ |
| `.ConfigureResource(...)` must be chained **after** `UseAzureMonitor()` | ✅ Required to override default resource detectors |
| Processors registered via `ConfigureOpenTelemetryTracerProvider` **before** `UseAzureMonitor()` | ✅ |
| `cloud_RoleName` derives from `service.namespace` + `service.name`, falling back to `service.name`; `cloud_RoleInstance` from `service.instance.id` | ✅ |
| Connection string should be supplied via the `APPLICATIONINSIGHTS_CONNECTION_STRING` environment variable | ✅ — the `appsettings.json` path is deprecated |
| Without meaningful `Cloud_RoleName`, Application Map and other portal features **do not function** | ✅ Explicit |
| **Live Metrics cannot split data by role name** | ✅ Explicit — a real cost of sharing one resource across services |

### Sampling

| Claim | Status |
|---|---|
| The distro's sampler *"shows complete traces and avoids broken ones"* | ✅ |
| `ApplicationInsightsSampler` is the default when sampling is not configured | ✅ |
| **Live Metrics requires the Azure Monitor sampler** | ✅ |
| **Metrics are not sampled** — so alert on metrics | ✅ |
| Verify the effective rate with `100 / avg(itemCount)` | ✅ |
| Daily cap is a *"last-resort control, not a replacement for sampling"* and *"can create a gap in telemetry"* | ✅ |
| Ingestion sampling is **not** recommended | ✅ |
| Export logs at ERROR, adding WARN where actionable | ✅ |
| Trace-based sampling for logs drops logs tied to unsampled traces | ✅ — added during verification |
| `TracesPerSecond` defaults to **5** in exporter 1.8.x — sampling is active before you configure it | ✅ — verified empirically: 58 spans emitted, 25 landed, tagged `microsoft.sample_rate: 50` |
| The exporter installs its sampler at registration, **overriding** a sampler set earlier on the builder | ✅ — verified empirically; fix requires `TracesPerSecond = null` **and** `SetSampler()` placed after `AddAzureMonitorTraceExporter` |

### Database semantic conventions

| Claim | Status |
|---|---|
| Exporter **1.4.0** does not map stable `db.*` conventions — yields `DependencyType = "Other"`, empty `Data` | ✅ — verified empirically |
| Exporter **1.8.3** maps them correctly (`SQL`, statement in `Data`, db name in `Target`) | ✅ — verified empirically |
| SqlClient **1.14.0-rc.1+** removed `OTEL_SEMCONV_STABILITY_OPT_IN`; stable conventions only | ✅ — CHANGELOG |
| SqlClient **1.12.0-beta.3+** removed `SetDbStatementForText`; query text always captured, and sanitized (literals → `?`) | ✅ — CHANGELOG |
| `AppDependencies.ResultCode` is **empty for successful SQL dependencies** — exporter never sets it | ✅ — verified in exporter source and empirically |
| `AppDependencies.Name` carries a **`SQL: ` prefix** for SQL dependencies via the OTel exporter path | ✅ — verified empirically from a pure-OTel process (contradicts the "legacy SDK only" assumption) |
| Cosmos .NET SDK emits `cosmosdb` + `az.namespace`, **not** the registry's `azure.cosmosdb` | ⚠️ Divergence — follow the SDK; the registry value matches no production data today |

### Live (real-time) telemetry

| Claim | Status |
|---|---|
| Pre-aggregated **metrics do not populate from back-dated telemetry**, but do populate from live emission | ✅ — verified empirically: `requests/count` on `ai-retail-web` read 0 across a 24 h backfill, then 236 / 172 / 267 in the exact minutes a live run was emitting, and 0 again either side. This is why the portfolio workbook queries log tables, not metrics |
| Log ingestion latency is **1–2 minutes** even for live-timestamped telemetry | ✅ — verified; Live Metrics is the only sub-second surface |
| `ILogger` → `AppTraces` stays 100 % correlated in live mode (`OperationId` + `ParentId`) | ✅ — verified: 167/167 rows across 5 services |
| Calling `ForceFlush` on a schedule during live emission **stalls the loop** | ✅ — verified: a 15 s flush across 8 providers produced visible multi-second gaps and dropped throughput from 60 to 51 traces/min. Removed; the batch processors' own 5 s schedule is sufficient |
| Disposing `ILoggerFactory` to flush logs **permanently disables logging** for anything emitted afterwards | ✅ — verified the hard way; there is no `ForceFlush` on `ILoggerFactory`, so disposal must happen only at shutdown |

### Browser correlation (JavaScript SDK)

| Claim | Status |
|---|---|
| `distributedTracingMode` default is **`AI_AND_W3C`**, not `W3C` | ✅ — corrected an implicit assumption in the sample |
| W3C headers are included automatically for **same-domain** requests | ✅ |
| `enableCorsCorrelation` defaults to `false` and applies to cross-origin requests | ✅ |
| Enabling it for all requests **can break calls** to servers that reject the headers | ✅ Explicit, with `correlationHeaderExcludedDomains: ['*.auth0.com']` as the documented remedy |
| `correlationHeaderDomains` (allow-list), `correlationHeaderExcludedDomains`, `correlationHeaderExcludePatterns` | ✅ All three names verified |
| `enableRequestHeaderTracking` / `enableResponseHeaderTracking` default `false`; `ignoreHeaders` defaults to `["Authorization", "X-API-Key", "WWW-Authenticate"]` | ✅ — and overriding `ignoreHeaders` discards those defaults |

### Querying

| Claim | Status |
|---|---|
| *"You don't need a cross-workspace query to query data from multiple applications in the same workspace"* | ✅ — the strongest practical argument for consolidation |
| `workspace()` for workspace-based resources; `app()` for classic | ✅ |
| Max 100 workspaces / classic resources per query | ✅ |
| Cross-resource query-pack functions unusable in log search alerts | ✅ |

---

## Claims held with lower confidence

These are flagged in-place in the documents. They are reasonable, but were **not** confirmed against a primary Microsoft source during this pass — verify before relying on them.

| ⚠️ Claim | Where | Why it is uncertain |
|---|---|---|
| EF Core instrumentation option names `SetDbStatementForText` / `SetDbStatementForStoredProcedure` | [04 — Sample 4](./04-csharp-instrumentation.md) | Community-maintained package, not Microsoft-supported; option names have changed across versions. Already hedged in the document |
| `activity.AddException(ex)` | [04](./04-csharp-instrumentation.md) | A newer .NET API surface; older targets need `RecordException` semantics via events. Already hedged |
| Clearing `ActivityTraceFlags.Recorded` in a filtering processor | [04 — Sample 10](./04-csharp-instrumentation.md) | Microsoft's documented example demonstrates `IsAllDataRequested = false`. The additional flag manipulation is a community pattern and may be unnecessary |
| Commitment tier discount magnitude | [02](./02-resource-topology.md) | Published figures vary by source and change over time. Treat any specific percentage as indicative; check current pricing |
| Effort estimates in the roadmap | [08](./08-implementation-roadmap.md) | Judgment, not documentation. Organization-dependent |
| Application Map readability threshold (~15–20 nodes) | [02](./02-resource-topology.md) | A practical heuristic, not a documented limit |

> **On the design opinions generally:** the *structure* of this architecture — the taxonomy, the metadata contract, the portfolio hub design, the maturity model, the build-vs-buy split — is engineering judgment, not Microsoft guidance. It is built on top of verified platform behaviour, but Microsoft does not publish an opinion on, say, how many business domains you should have. The verification above covers **platform facts**, not **design choices**.

---

## Verification pass 2 — Microsoft Fabric integration

Scope: every platform claim in [10 — Fabric Integration](./10-fabric-integration.md), checked against Microsoft Fabric and Azure Monitor documentation.

### Confirmed

| Claim | Verified detail |
|---|---|
| Fabric Real-Time Dashboards support Azure Monitor natively | Both **Application Insights and Log Analytics** are selectable data sources. Connect by subscription / resource group / resource name, or a full connection URI. No export, no data movement |
| ADX cross-service query into Azure Monitor | `cluster('https://adx.monitor.azure.com/subscriptions/<sub>/...')`. A **subscription-scoped URI exposes every workspace and app in that subscription as one cluster** |
| Cross-service query is retrieval-only | Only `.show functions` is supported. Azure Monitor cannot be *managed* from Fabric |
| Cross-service queries inherit cross-resource limits | Path A does **not** escape the 100-resource ceiling. Only ingestion does |
| Eventstream managed private endpoints | **GA**, not preview. Targets are **Azure Event Hubs and Azure IoT Hub only** |
| Fabric managed private endpoints list `Microsoft.Insights/privateLinkScopes` | Supported for **Data Engineering (Spark/notebooks) and Eventstream** workloads — *not* Eventhouse or Real-Time Dashboard |
| Data export rule limits | Max **10 rules per workspace**; **Analytics and Basic plans only — Auxiliary not supported**; destination must be in the **workspace's region** |
| Data export sends no historical data | Forward-only. Backfill requires Path C |
| Data export retry behaviour | Retries for up to 12 hours, then discards; may produce duplicates |
| Data export billing | Bills on **uncompressed JSON**, which is larger than the reported table size. Docs recommend measuring a representative export rather than estimating |
| Data export cannot reach a firewalled Event Hub | Requires the trusted-Microsoft-services bypass |
| Diagnostic settings → Event Hub is lower-latency than workspace export | For Azure resource logs, add Event Hub as a second diagnostic-setting destination rather than double-handling |
| Power BI export from Log Analytics | `Export → Power BI (M query)` and `Export → Power BI (new Dataset)`; also the Azure Log Analytics connector in dataflows with incremental refresh (needs a datetime field) |
| Power BI export is subject to Query API limits | Returns **partial results** if exceeded — aggregate in KQL before export, never export raw |
| The RBAC-ceiling argument | Microsoft's own guidance names the scenario: *"Sharing insights with stakeholders who don't have access to Log Analytics"* |

### Corrections made during this pass

| # | Initial claim | Correction |
|---|---|---|
| 9 | "Private Link blocks Fabric integration." | **Wrong as stated.** Fabric managed private endpoints explicitly support Azure Monitor Private Link Scopes for Data Engineering and Eventstream workloads |
| 10 | "AMPLS estates must fall back to scheduled extraction." | **Wrong, and architecturally significant.** The Private Link limitation applies **only to the query-federation path** (`adx.monitor.azure.com`). Ingestion via Event Hub → Eventstream is immune: Azure Monitor *pushes* to Event Hub and Eventstream *pulls* over a managed private endpoint, so the proxy is never involved. This reframed Path B from a fallback into the **recommended durable foundation** |
| 11 | Doc 06 delivery-surface table said Power BI "needs data export; not real-time." | **Incomplete.** Real-Time Dashboards query Azure Monitor directly with no export. Table corrected in [06](./06-application-portfolio.md) |

### Lower-confidence in doc 10

| Claim | Why it is uncertain |
|---|---|
| **Capacity requirement for Eventstream managed private endpoints** | **Resolved — see below.** Sources genuinely disagree, but the conflict is now adjudicated rather than open |
| Relative cost of Eventhouse retention vs. Log Analytics | Directionally correct and widely observed, but pricing-dependent. Model it against current rates rather than assuming |
| Adoption phasing in doc 10 | Engineering judgment, not documentation |

### Adjudicated: the F-SKU capacity conflict

Both pages were fetched directly and the discrepancy is real, not a misreading:

| Source | Statement |
|---|---|
| Eventstream — *Connect to Azure resources securely using managed private endpoints*, Prerequisites | *"Managed private endpoints are supported for **Fabric trial** and **all Fabric F SKU** capacities."* |
| *Overview of managed private endpoints for Fabric* | *"Managed private endpoints are supported on Microsoft Fabric capacities with **64 or more capacity units**, including Trial, F64, and larger capacities."* |

**Adjudication: design against F64+.** The overview page is the authoritative document for the platform capability, states the constraint as a note rather than in passing, and is the more restrictive of the two. The Eventstream prerequisite line is most likely a stale simplification. Treat any capacity below F64 as something to prove in your own tenant before committing an architecture to it.

**Additional constraint discovered during this adjudication** — not previously captured: managed private endpoints require **Fabric Data Engineering (Spark) workload support in both the tenant home region and the capacity region**, and creation is *blocked* in regions without it. This applies even though the Eventstream → Eventhouse pattern never runs a Spark job. Added to [10](./10-fabric-integration.md).

**Also corrected:** the platform overview page links to the Eventstream article with a "(Preview)" label. That link text is stale — the Eventstream article itself documents a GA release with expanded region availability and production support. GA is the correct status.

---

## Primary sources consulted

- Architecture best practices for Application Insights (Azure Well-Architected Framework service guide)
- Best practices for Azure Monitor Logs
- Design a Log Analytics workspace architecture
- Create and configure workspace-based Application Insights resources
- Query across multiple workspaces and apps in Azure Monitor
- Dependency tracking in Application Insights
- Enable Azure Monitor OpenTelemetry for .NET
- Configure the Azure Monitor OpenTelemetry Distro
- Add, modify, and filter OpenTelemetry
- Sampling in Application Insights / OpenTelemetry sampling
- Collect and detect: telemetry collection guidance
- Microsoft Azure Monitor Application Insights JavaScript SDK configuration
- Azure Workbooks data sources
- Azure Workbooks link actions
- Query data in Azure Monitor using Azure Data Explorer (cross-service query)
- Log Analytics workspace data export in Azure Monitor
- Import Azure Monitor log data into Power BI
- Real-Time Dashboard data sources (Microsoft Fabric)
- Create managed private endpoints in Fabric Eventstream
- Managed private endpoints for Microsoft Fabric (supported data sources)
- Overview of managed private endpoints for Fabric
- Cross-cluster and cross-service queries in Fabric Real-Time Intelligence

---

**Next:** [10 — Fabric Integration](./10-fabric-integration.md) · **Back:** [README](./README.md)
