import { credential } from './credential.js';
import { listCatalog } from './catalogDb.js';
import { getRegistrations, getReportedResources, isResourceId } from './resourceGraph.js';
import { queryLogAnalytics, type QueryRow } from './logAnalytics.js';
import { examplesQuery, groupQuery, makeWindow, portfolioQuery, topologyQuery, transactionQuery } from './portfolioQueries.js';
import { compareTarget } from '../common/portfolio.js';
import type {
  AppSummary, AzureResource, DependencyConnection, GroupSummary, HostObservation,
  Measures, Portfolio, QueryWindow, TraceEvent, TraceSpan, Transaction, TransactionExample,
} from '../common/portfolio.js';
import type { CatalogModel } from '../common/shared.js';

export class InputError extends Error {}

export function parseWindow(hours: unknown, end: unknown): QueryWindow {
  const n = hours === undefined ? 168 : Number(hours);
  if ((hours !== undefined && typeof hours !== 'string') || !Number.isInteger(n) || n < 1 || n > 720) {
    throw new InputError('rangeHours must be an integer between 1 and 720.');
  }
  if (end !== undefined && (typeof end !== 'string' || !Number.isFinite(Date.parse(end)))) {
    throw new InputError('end must be an ISO timestamp.');
  }
  const date = end === undefined ? new Date() : new Date(String(end));
  if (date.getTime() > Date.now() + 60_000) throw new InputError('The query end cannot be in the future.');
  return makeWindow(n, date);
}

const str = (v: unknown) => v === null || v === undefined ? '' : String(v);
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0;
const date = (v: unknown) => v ? new Date(str(v)).toISOString() : null;
const bool = (v: unknown): boolean | null => v === null || v === undefined ? null : Boolean(v);
const strings = (v: unknown): string[] => {
  if (v === null || v === undefined || v === '') return [];
  const parsed: unknown = typeof v === 'string' ? JSON.parse(v) : v;
  if (!Array.isArray(parsed)) throw new Error('Log Analytics returned an invalid resource-identity array.');
  return parsed.map(str).filter(Boolean);
};
const empty = (): Measures => ({ rows: 0, items: 0, good: 0, failed: 0, unknown: 0, p95: null, first: null, last: null });
export const measures = (r?: QueryRow): Measures => r ? {
  rows: number(r.Rows), items: number(r.Calls), good: number(r.Good), failed: number(r.Fails),
  unknown: number(r.Unknown), p95: r.P95 === null || r.P95 === undefined ? null : number(r.P95),
  first: date(r.FirstSeen), last: date(r.LastSeen),
} : empty();
const errorMessage = (e: unknown) => e instanceof Error ? e.message : String(e);

async function run(query: string): Promise<QueryRow[]> {
  const workspaceId = process.env.LA_WORKSPACE_ID;
  if (!workspaceId) throw new Error('LA_WORKSPACE_ID must be set.');
  const host = process.env.LA_API_HOST?.trim() || 'https://api.loganalytics.io';
  const token = await credential.getToken(`${host.replace(/\/+$/, '')}/.default`);
  if (!token?.token) throw new Error('Failed to acquire a Log Analytics token.');
  return queryLogAnalytics({ workspaceId, host, token: token.token, query });
}

export function assemblePortfolio(
  rows: QueryRow[],
  topology: QueryRow[],
  registrations: AzureResource[],
  catalog: CatalogModel[],
  window: QueryWindow,
): Portfolio {
  if (rows.length > 12000 || topology.length > 6000) {
    throw new Error('Portfolio result exceeds the supported result budget; narrow the time range.');
  }
  const byId = new Map<string, AppSummary>();
  const resources = new Map(registrations.map((r) => [r.id.toLowerCase(), r]));
  const entries = new Map(catalog.map((r) => [r.workload.toLowerCase(), r]));
  const app = (id: string): AppSummary => {
    const key = id.toLowerCase();
    let value = byId.get(key);
    if (!value) {
      const cat = entries.get(key) ?? null;
      value = {
        id, name: cat?.displayName || id, domain: '', criticality: '', owner: '', resourceIds: [],
        registered: false, catalog: cat, current: empty(), previous: empty(), trend: [],
        lastSeen: null, hosts: [], findings: [], target: compareTarget(cat?.slo, empty()),
      };
      byId.set(key, value);
    }
    return value;
  };
  for (const r of rows) {
    if (!str(r.App)) continue;
    const a = app(str(r.App));
    a.resourceIds = [...new Set([...a.resourceIds, ...strings(r.ResourceIds).map((id) => id.toLowerCase())])];
    if (r.Section === 'app') {
      if (r.Period === 'current') a.current = measures(r);
      else a.previous = measures(r);
    } else if (r.Section === 'freshness') {
      a.lastSeen = date(r.LastSeen);
    } else if (r.Section === 'trend') {
      a.trend.push({ ...measures(r), time: new Date(str(r.Bucket)).toISOString() });
    } else if (r.Section === 'host') {
      const hostId = str(r.HostId);
      a.hosts.push({
        app: a.id, instance: str(r.Instance), componentId: str(r.Component),
        resourceId: hostId || null, observedAt: new Date(str(r.LastSeen)).toISOString(),
        state: !hostId ? 'unavailable' : isResourceId(hostId) ? 'unverified' : 'invalid', resource: null,
      });
    }
  }
  for (const c of catalog) app(c.workload);
  for (const a of byId.values()) {
    const registered = a.resourceIds.map((id) => resources.get(id)).filter((r): r is AzureResource => Boolean(r));
    a.registered = registered.length > 0;
    for (const field of ['domain', 'criticality', 'owner'] as const) {
      const values = [...new Set(registered.map((r) => r[field]))];
      a[field] = values.length === 1 ? values[0] : '';
      if (values.length > 1) a.findings.push(`Conflicting ${field} across telemetry resources`);
      else if (!a[field]) a.findings.push(`Missing ${field}`);
    }
    if (!a.current.rows) a.findings.push('No request/processing observations in this range');
    if (!a.catalog) a.findings.push('No business-context entry');
    else {
      for (const field of ['description', 'businessOwner', 'onCall', 'runbookUrl'] as const) {
        if (!a.catalog[field]) a.findings.push(`Missing ${field}`);
      }
      if (!a.catalog.isActive) a.findings.push('Catalog entry is inactive');
    }
    a.target = compareTarget(a.catalog?.slo, a.current);
    if (a.target.state === 'below') a.findings.push('Below request-success target');
    if (a.target.state === 'invalid') a.findings.push('Invalid request-success target');
    a.trend.sort((x, y) => x.time.localeCompare(y.time));
  }
  const apps = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  const connections: DependencyConnection[] = topology.filter((r) => r.Section === 'edge').map((r) => ({
    id: str(r.EdgeId), source: str(r.SourceId), destination: str(r.TargetId),
    destinationKind: r.DestinationKind === 'service' ? 'service' : 'target',
    target: str(r.RawTarget), protocol: str(r.DependencyType),
    evidence: r.Evidence === 'matched spans' ? 'matched spans' : r.Evidence === 'inferred hostname' ? 'inferred hostname' : 'observed target',
    current: measures(r),
  }));
  return {
    window, generatedAt: new Date().toISOString(), warnings: [], apps, groups: [],
    registrations: registrations.map((resource) => ({
      resource, roles: apps.filter((a) => a.resourceIds.includes(resource.id)).map((a) => a.id),
    })),
    targets: topology.filter((r) => r.Section === 'node' && r.Kind !== 'service').map((r) => ({
      id: str(r.Id), name: str(r.Name) || str(r.Id), kind: str(r.Kind), target: str(r.RawTarget),
      protocol: str(r.DependencyType), current: measures(r),
    })),
    connections, workspaceResourceId: process.env.LA_WORKSPACE_RESOURCE_ID ?? '',
  };
}

export function assembleGroups(rows: QueryRow[], apps: AppSummary[]): GroupSummary[] {
  if (rows.length > 6000) throw new Error('Portfolio group results exceed the supported result budget.');
  const result = new Map<string, GroupSummary>();
  for (const a of apps) for (const kind of ['domain', 'owner'] as const) {
    const name = a[kind] || 'Unclassified';
    const key = `${kind}:${name}`;
    let g = result.get(key);
    if (!g) {
      g = { kind, name, apps: 0, tier1: 0, current: empty(), previous: empty(), trend: [] };
      result.set(key, g);
    }
    g.apps++;
    if (a.criticality === 'tier1') g.tier1++;
  }
  for (const r of rows) {
    const g = result.get(`${str(r.GroupKind)}:${str(r.Group) || 'Unclassified'}`);
    if (!g) continue;
    if (r.Section === 'group-trend') g.trend.push({ ...measures(r), time: new Date(str(r.Bucket)).toISOString() });
    else if (r.Period === 'current') g.current = measures(r);
    else g.previous = measures(r);
  }
  return [...result.values()].map((g) => ({ ...g, trend: g.trend.sort((a, b) => a.time.localeCompare(b.time)) }));
}

export async function getPortfolio(window: QueryWindow): Promise<Portfolio> {
  const warnings: string[] = [];
  const workspace = process.env.LA_WORKSPACE_RESOURCE_ID;
  const [rows, topology, registrations, catalog] = await Promise.all([
    run(portfolioQuery(window)), run(topologyQuery(window)),
    (workspace ? getRegistrations(workspace, process.env.ARM_HOST || undefined)
      : Promise.reject(new Error('LA_WORKSPACE_RESOURCE_ID is not set.')))
      .catch((e: unknown) => { warnings.push(`Registration coverage unavailable: ${errorMessage(e)}`); return []; }),
    listCatalog().catch((e: unknown) => { warnings.push(`Business context unavailable: ${errorMessage(e)}`); return []; }),
  ]);
  const portfolio = assemblePortfolio(rows, topology, registrations, catalog, window);
  const domains = Object.fromEntries(portfolio.apps.map((a) => [a.id, a.domain || 'Unclassified']));
  const owners = Object.fromEntries(portfolio.apps.map((a) => [a.id, a.owner || 'Unclassified']));
  portfolio.groups = assembleGroups(await run(groupQuery(window, domains, owners)), portfolio.apps);
  const hosts = portfolio.apps.flatMap((a) => a.hosts).filter((h) => h.state === 'unverified' && h.resourceId);
  if (hosts.length) {
    try {
      const resolved = await getReportedResources(hosts.map((h) => h.resourceId!), process.env.ARM_HOST || undefined);
      const byId = new Map(resolved.map((r) => [r.id, r]));
      for (const host of hosts) {
        const resource = byId.get(host.resourceId!.toLowerCase());
        if (resource && resource.type.toLowerCase() !== 'microsoft.insights/components') {
          host.resource = resource;
          host.state = 'verified';
        }
      }
    } catch (e) {
      warnings.push(`Hosting resource verification unavailable: ${errorMessage(e)}`);
    }
  }
  portfolio.warnings = warnings;
  return portfolio;
}

export async function getExamples(window: QueryWindow, app: string, failed: boolean): Promise<{
  items: TransactionExample[]; truncated: boolean;
}> {
  if (!app || app.length > 250) throw new InputError('app is required and must be at most 250 characters.');
  const rows = await run(examplesQuery(window, app, failed));
  return {
    items: rows.slice(0, 50).map((r) => ({
      operationId: str(r.OperationId), spanId: str(r.Id), app: str(r.App), name: str(r.Name),
      time: new Date(str(r.TimeGenerated)).toISOString(), duration: number(r.DurationMs),
      success: bool(r.Success), resultCode: str(r.ResultCode),
    })),
    truncated: rows.length > 50,
  };
}

export function assembleTransaction(rows: QueryRow[], operationId: string, window: QueryWindow): Transaction {
  const spanRows = rows.filter((r) => r.Section === 'span');
  const eventRows = rows.filter((r) => r.Section === 'event');
  const spans = spanRows.slice(0, 2000).map<TraceSpan>((r) => ({
    operationId, spanId: str(r.Id), parentId: str(r.ParentId), app: str(r.App), name: str(r.Name),
    time: new Date(str(r.TimeGenerated)).toISOString(), duration: number(r.DurationMs), success: bool(r.Success),
    resultCode: str(r.ResultCode), kind: r.Kind === 'request' ? 'request' : 'dependency',
    protocol: str(r.DependencyType), target: str(r.Target), resourceId: str(r.ResourceId),
  })).sort((a, b) => a.time.localeCompare(b.time));
  const boundedEvents = [
    ...eventRows.filter((r) => r.Kind === 'log').slice(0, 200),
    ...eventRows.filter((r) => r.Kind === 'exception').slice(0, 200),
  ];
  const events = boundedEvents.map<TraceEvent>((r) => ({
    time: new Date(str(r.TimeGenerated)).toISOString(), app: str(r.App), parentId: str(r.ParentId),
    kind: r.Kind === 'exception' ? 'exception' : 'log', message: str(r.Message), type: str(r.ExceptionType),
    severity: r.SeverityLevel === null || r.SeverityLevel === undefined ? null : number(r.SeverityLevel),
  })).sort((a, b) => a.time.localeCompare(b.time));
  const truncated = spanRows.length > 2000 || eventRows.filter((r) => r.Kind === 'log').length > 200 ||
    eventRows.filter((r) => r.Kind === 'exception').length > 200;
  const ids = new Set(spans.map((s) => s.spanId));
  const missing = spans.filter((s) => s.parentId && s.parentId !== operationId && !ids.has(s.parentId)).length;
  return {
    operationId, window, spans, events, truncated,
    warnings: [
      ...(missing ? [`${missing} spans have parents outside the retrieved operation/window; linked or sampled traces may be incomplete.`] : []),
      ...(truncated ? ['Transaction detail reached its result limit. Open Application Insights for additional evidence.'] : []),
      ...(!spans.length ? ['No spans were observed for this operation in the selected window.'] : []),
    ],
  };
}

export async function getTransaction(window: QueryWindow, operationId: string): Promise<Transaction> {
  if (!/^[0-9a-f]{32}$/i.test(operationId)) throw new InputError('operationId must be a 32-character W3C trace ID.');
  return assembleTransaction(await run(transactionQuery(window, operationId)), operationId, window);
}
