# 02 — Resource Topology

How many Application Insights resources, how many Log Analytics workspaces, and where the lines get drawn.

---

## The core model

```mermaid
flowchart TB
    subgraph D1["Domain: Order Management"]
        W1["Workload: Checkout"]
        W2["Workload: Fulfillment"]
    end
    subgraph D2["Domain: Customer"]
        W3["Workload: Identity"]
        W4["Workload: Self-Service Portal"]
    end
    subgraph D3["Domain: Finance"]
        W5["Workload: Billing"]
    end

    W1 --> AI1["AI: checkout-prod"]
    W2 --> AI2["AI: fulfillment-prod"]
    W3 --> AI3["AI: identity-prod"]
    W4 --> AI4["AI: portal-prod"]
    W5 --> AI5["AI: billing-prod"]

    AI1 --> LAW1[("LAW: prod-eastus")]
    AI2 --> LAW1
    AI3 --> LAW1
    AI4 --> LAW1
    AI5 --> LAW2[("LAW: prod-eastus-restricted")]

    LAW1 --> PF["Application Portfolio Hub"]
    LAW2 --> PF

    style AI5 fill:#ffe6cc,stroke:#d79b00,stroke-width:2px,color:#1a1a1a
    style LAW2 fill:#ffe6cc,stroke:#d79b00,stroke-width:2px,color:#1a1a1a
```

**Read the diagram:** Five workloads across three business domains produce five Application Insights resources — *not three*. Domain grouping happens through tags and telemetry attributes, and is reassembled in the portfolio layer. Billing is highlighted because it carries a compliance constraint (financial data) that forces a separate, restricted workspace — an exception justified by a real boundary, not by org structure.

---

## Application Insights: the split-or-share decision tree

```mermaid
flowchart TD
    START["Two components<br/>under consideration"] --> Q1{"Same environment?"}
    Q1 -->|No| SPLIT1["SPLIT<br/>never mix envs"]
    Q1 -->|Yes| Q2{"Same owning team<br/>and support model?"}
    Q2 -->|No| SPLIT2["SPLIT"]
    Q2 -->|Yes| Q3{"Different compliance,<br/>residency, or data-access<br/>requirements?"}
    Q3 -->|Yes| SPLIT3["SPLIT"]
    Q3 -->|No| Q4{"Do they participate in<br/>the same end-to-end<br/>user journey?"}
    Q4 -->|Yes| Q5{"Would combined volume<br/>overwhelm App Map<br/>or ingestion limits?"}
    Q4 -->|No| Q6{"Shared release lifecycle<br/>and SLOs?"}
    Q5 -->|No| SHARE1["SHARE<br/>preserves App Map<br/>and transaction view"]
    Q5 -->|Yes| SPLIT4["SPLIT<br/>and rely on<br/>cross-resource query"]
    Q6 -->|Yes| SHARE1
    Q6 -->|No| SPLIT5["SPLIT"]

    style SHARE1 fill:#d5e8d4,stroke:#82b366,stroke-width:2px,color:#1a1a1a
    style SPLIT1 fill:#f8cecc,stroke:#b85450,stroke-width:2px,color:#1a1a1a
    style SPLIT2 fill:#f8cecc,stroke:#b85450,stroke-width:2px,color:#1a1a1a
    style SPLIT3 fill:#f8cecc,stroke:#b85450,stroke-width:2px,color:#1a1a1a
    style SPLIT4 fill:#f8cecc,stroke:#b85450,stroke-width:2px,color:#1a1a1a
    style SPLIT5 fill:#f8cecc,stroke:#b85450,stroke-width:2px,color:#1a1a1a
```

### Rules of thumb

| Situation | Decision |
|---|---|
| 6 microservices, one team, one release train, one user journey | **One** Application Insights resource. Distinguish services via `service.name` / cloud role name |
| Same app, dev / test / prod | **Three** Application Insights resources |
| Two workloads that call each other across team boundaries | **Two** resources; correlate via cross-resource KQL and the portfolio hub |
| A workload with a PCI/PHI-scoped component | Split the sensitive component; consider a restricted workspace |
| A single service generating >50% of estate ingestion | Split it so its sampling and cost are independently tunable |

### The documented "share it" checklist

Microsoft lists specific conditions under which components should use a **single** Application Insights resource. Treat all of these as needing to be true — if any is false, you have a split candidate:

- [ ] The components are **deployed together** and developed/managed by the **same team**.
- [ ] Centralizing KPIs (response time, failure rate) in one dashboard is desirable, with segmentation by role name where needed.
- [ ] There is **no need for different Azure RBAC** between the components.
- [ ] **Identical** metric alert criteria, continuous export, and billing/quota management across components is acceptable.
- [ ] It is acceptable that an **API key can read data from all components equally**, and the limit of 10 API keys covers them all.
- [ ] The **same smart detection and work-item integration** settings suit every component.

> **The Live Metrics caveat.** Live Metrics **cannot split data by role name.** If several noisy services share one Application Insights resource, the Live Metrics stream becomes an undifferentiated firehose. This is a genuine, often-overlooked cost of sharing — weigh it for workloads where live triage during an incident matters.

> **Consolidation is not a migration.** If you point components at a new, consolidated Application Insights resource, telemetry in the old resource **does not transfer**. Keep the old resource until the new one holds enough history for business continuity, then delete it.

> **Cloud role name is mandatory, not cosmetic.** Without meaningful `Cloud_RoleName` values, Application Map and several other portal experiences simply do not function. For most app types you must set it explicitly (Service Fabric and classic Cloud Services infer it). See [04 — C# Instrumentation](04-csharp-instrumentation.md).

---

## Log Analytics: the consolidation decision

> **Start from one workspace — for the entire estate.** Microsoft's workspace design guidance is unusually direct about this: *"Your design should always start with a single workspace to reduce the complexity of managing multiple workspaces and in querying data from them. There are no performance limitations from the amount of data in your workspace... As you identify criteria to create more workspaces, your design should use the fewest number of workspaces to meet your requirements."*
>
> Every additional workspace is a cost you pay forever in query complexity, alert scoping, RBAC administration, and workbook maintenance. Make each one earn its existence against a documented criterion below.

**Notably, "different Azure region" is not by itself a reason to split.** Microsoft's guidance is to use a single workspace across regions unless you have a geography/residency requirement. Two commonly-assumed objections are weaker than people think:

- **Egress charges** — bandwidth charges for cross-region log ingestion are described as "usually minor compared to the total cost." Critically, **data sent to a workspace by Azure diagnostic settings does not incur egress charges at all.** The charge applies to agent-collected data (VMs and similar).
- **Latency** — not a documented driver of workspace design.

The real region-driven reasons are **data residency/sovereignty** and **resilience** (deliberately ingesting to workspaces in more than one region so a regional outage doesn't blind you).

### Split criteria (aligned to the documented list)

```mermaid
flowchart TD
    S["Default: one workspace"] --> T1{"Security data with a<br/>separate SecOps ownership<br/>or Sentinel boundary?"}
    T1 -->|Yes| N1["Separate workspace"]
    T1 -->|No| T2{"Spans multiple<br/>Microsoft Entra tenants?"}
    T2 -->|Yes| N2["One workspace per tenant"]
    T2 -->|No| T3{"Data residency or<br/>sovereignty requirement<br/>for a geography?"}
    T3 -->|Yes| N3["Workspace in that geography"]
    T3 -->|No| T4{"Distinct legal-entity<br/>data ownership?"}
    T4 -->|Yes| N4["Separate workspace"]
    T4 -->|No| T5{"Hard billing separation<br/>required — not solvable<br/>with usage queries + tags?"}
    T5 -->|Yes| N5["Separate workspace"]
    T5 -->|No| T6{"Different retention needed<br/>for the SAME table?"}
    T6 -->|Yes| N6["Separate workspace"]
    T6 -->|No| T7{"Access control unachievable<br/>with resource-context or<br/>table-level RBAC?"}
    T7 -->|Yes| N7["Separate workspace"]
    T7 -->|No| T8{"Resilience: need ingestion<br/>to survive a region loss?"}
    T8 -->|Yes| N8["Duplicate ingestion to a<br/>second-region workspace"]
    T8 -->|No| SHARE["SHARE the existing workspace"]

    style SHARE fill:#d5e8d4,stroke:#82b366,stroke-width:2px,color:#1a1a1a
    style S fill:#dae8fc,stroke:#6c8ebf,stroke-width:2px,color:#1a1a1a
```

Two criteria deserve expansion because they are routinely misapplied:

- **Retention.** Retention is configurable **per table**, so differing retention needs across *applications* usually do **not** justify a workspace split. A split is justified only when the *same table* must carry different retention for different sources.
- **Billing.** A workspace split is a blunt instrument for chargeback. Usage queries by resource, plus consistent tagging, satisfy most chargeback models without fragmenting the data. Split only when a separate party must literally receive a separate Azure bill.

**Commitment tiers push the other way:** consolidating ingestion into fewer workspaces raises daily volume, which qualifies you for larger commitment-tier discounts. Fragmenting a 300 GB/day estate across ten workspaces can leave every one of them on pay-as-you-go.

### Valid vs invalid split reasons

| ✅ Valid | ❌ Invalid |
|---|---|
| Separate Microsoft Entra tenants | "Each team wants their own" |
| Data residency / sovereignty for a geography | Different Azure region, absent a residency requirement |
| Distinct legal-entity data ownership | Org chart / reporting line |
| Genuine split billing to separate parties | Cosmetic cost attribution (use usage queries + tags) |
| Different retention **for the same table** | Different retention across apps (use table-level retention) |
| Access control that resource-context and table-level RBAC cannot express | "It feels cleaner" |
| Security/SecOps data separation (Sentinel boundary) | One-off dashboard convenience |
| Deliberate multi-region resilience | Different programming language or release cadence |
| Legacy agent multi-homing limitations | Different Application Insights resource |

> **Prod vs non-prod is a nuance, not an automatic split.** Separate Application Insights resources per environment are non-negotiable. Separate *workspaces* per environment are optional — justify them with access control, retention, or noise-isolation reasoning, and be aware you may forfeit commitment-tier volume by doing so. Many estates are well served by one workspace with environment carried as a resource attribute and dimension.

---

## Worked topology example

A mid-size estate: 3 business domains, 14 workloads, 2 regions, 3 environments.

Start from one workspace and apply the criteria. Only one criterion fires: three workloads serve EU customers and carry a data-residency obligation.

```mermaid
flowchart LR
    subgraph Main["Primary workspace — East US"]
        LAW1[("LAW: law-platform-eastus")]
        AIDEV["14 x AI dev"] --> LAW1
        AITEST["14 x AI test"] --> LAW1
        AIPE["11 x AI prod"] --> LAW1
    end

    subgraph EU["EU residency boundary — West Europe"]
        LAW2[("LAW: law-platform-westeurope")]
        AIPW["3 x AI prod<br/>EU-resident data"] --> LAW2
    end

    LAW1 --> HUB["Portfolio Hub<br/>cross-workspace query"]
    LAW2 --> HUB

    style LAW1 fill:#dae8fc,stroke:#6c8ebf,stroke-width:2px,color:#1a1a1a
    style LAW2 fill:#ffe6cc,stroke:#d79b00,stroke-width:2px,color:#1a1a1a
    style HUB fill:#d5e8d4,stroke:#82b366,stroke-width:2px,color:#1a1a1a
```

**Result: 42 Application Insights resources, 2 Log Analytics workspaces.**

That ratio is the signature of a healthy design. Application Insights resources are diagnostic, workload-scoped, and numerous. Workspaces are analytical, governed, and few.

Note what did **not** produce a split:

| Tempting split | Why it was rejected |
|---|---|
| Prod vs non-prod workspaces | Access control is satisfied by resource-context RBAC; environment is a queryable dimension; consolidating keeps the estate in a commitment tier |
| One workspace per business domain | Domain is an attribute, not a boundary — and splitting would break the cross-domain portfolio query outright |
| One workspace per region | No residency requirement for the second region's workloads; diagnostic-settings data incurs no egress charge |
| One workspace per subscription | Subscriptions are a billing/lifecycle construct, not a telemetry boundary |

> **The colocation tension, stated honestly.** Well-Architected guidance recommends deploying an Application Insights resource in the same region as its Log Analytics workspace. A single consolidated workspace and a multi-region application estate cannot both satisfy that fully. Resolve it deliberately:
>
> - **Small/medium multi-region estates:** favor consolidation. Accept cross-region Application Insights → workspace linkage. The operational simplicity is usually worth more than the marginal ingress path.
> - **Regulated or latency/sovereignty-sensitive geographies:** favor colocation and accept a second workspace — this is exactly the residency criterion firing.
> - **Never** create a workspace per region *and* claim you did it for colocation if no residency, resilience, or sovereignty requirement exists. That is the region anti-pattern wearing a Well-Architected badge.

---

## Sizing and limit guardrails

| Concern | Guardrail |
|---|---|
| Cross-resource query breadth | **Hard limit: a single query may span at most 100 workspaces or classic Application Insights resources.** Keep routine portfolio queries within a bounded, Resource-Graph-selected set — and note that consolidating workspaces is what keeps you far below this ceiling |
| Application Map readability | If a workload's map exceeds roughly 15–20 nodes, reconsider the workload boundary |
| Ingestion spikes | Per-workload sampling and source filtering **before** workspace-level daily caps |
| Workspace count growth | Every new workspace requires a written justification against one of the documented split criteria |
| Region expansion | A new region does **not** create a workspace by default. It creates one only when residency, sovereignty, or a deliberate resilience requirement applies |
| Commitment tier erosion | Before splitting, check whether the split drops either side below a commitment-tier threshold |

---

## Migration notes

- **Classic Application Insights is retired.** All resources must be workspace-based.
- Converting classic → workspace-based preserves data continuity and unlocks CMK, Private Link, BYOS, and commitment tiers.
- Moving an Application Insights resource between workspaces does **not** migrate historical data; plan a cutover date and keep the old workspace readable through its retention window.
- Cross-subscription workspace linkage requires `Microsoft.OperationalInsights/workspaces/sharedKeys/action` on the target workspace, even within the same tenant.
