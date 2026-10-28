import { failureStatus } from '../common/portfolio';
import type {
  GraphLens, GraphProjection, Portfolio, Transaction, ViewEdge, ViewNode,
} from '../common/portfolio';

export const appNodeId = (id: string) => `app:${id}`;
export const domainNodeId = (name: string) => `domain:${name || 'Unclassified'}`;
const targetNodeId = (id: string) => `dependency:${id}`;

export function projectGraph(
  portfolio: Portfolio,
  lens: GraphLens,
  expanded: Set<string>,
  revealApps = new Set<string>(),
): GraphProjection {
  const nodes = new Map<string, ViewNode>();
  const edges = new Map<string, ViewEdge>();
  const apps = new Map(portfolio.apps.map((a) => [a.id, a]));
  const domainExpanded = new Set(expanded);
  for (const id of revealApps) {
    const app = apps.get(id);
    if (app) domainExpanded.add(app.domain || 'Unclassified');
  }
  const nodeForApp = (id: string) => {
    const app = apps.get(id);
    if (!app) return appNodeId(id);
    const domain = app.domain || 'Unclassified';
    return lens === 'domains' && !domainExpanded.has(domain) ? domainNodeId(domain) : appNodeId(id);
  };
  if (lens === 'domains') {
    for (const g of portfolio.groups.filter((g) => g.kind === 'domain')) {
      nodes.set(domainNodeId(g.name), {
        id: domainNodeId(g.name), entityId: g.name, label: `${g.name}\n${g.apps} apps · ${g.tier1} tier1`,
        kind: 'domain', shape: 'round-rectangle', domain: g.name, status: failureStatus(g.current),
        volume: g.current.items, expanded: domainExpanded.has(g.name),
      });
    }
  }
  for (const a of portfolio.apps) {
    const domain = a.domain || 'Unclassified';
    if (lens === 'domains' && !domainExpanded.has(domain)) continue;
    nodes.set(appNodeId(a.id), {
      id: appNodeId(a.id), entityId: a.id, label: a.name, kind: 'service',
      shape: 'round-rectangle', domain, status: failureStatus(a.current), volume: a.current.items,
      ...(lens === 'domains' ? { parent: domainNodeId(domain) } : {}),
    });
  }
  if (lens !== 'domains') {
    for (const t of portfolio.targets) nodes.set(targetNodeId(t.id), {
      id: targetNodeId(t.id), entityId: t.id, label: t.name, kind: 'target',
      shape: t.kind === 'queue' ? 'diamond' : ['database', 'datastore'].includes(t.kind) ? 'barrel' : 'round-hexagon',
      domain: '', status: 'Infra', volume: t.current.items,
    });
  }
  for (const c of portfolio.connections) {
    if (lens === 'domains' && c.destinationKind === 'target') continue;
    const source = nodeForApp(c.source);
    const target = c.destinationKind === 'service' ? nodeForApp(c.destination) : targetNodeId(c.destination);
    if (source === target || !nodes.has(source) || !nodes.has(target)) continue;
    const key = `${source}\u0000${target}`;
    let e = edges.get(key);
    if (!e) {
      e = { id: `calls:${encodeURIComponent(key)}`, source, target, relation: 'calls', label: '',
        connections: [], calls: 0, failed: 0 };
      edges.set(key, e);
    }
    e.connections.push(c.id);
    e.calls += c.current.items;
    e.failed += c.current.failed;
    e.label = `${e.calls.toLocaleString()} observed${e.failed ? ` · ${e.failed} failed` : ''}`;
  }
  if (lens === 'resources') {
    const linkResource = (app: string, id: string, name: string, relation: 'telemetry' | 'hosting', verified: boolean) => {
      const nid = `${relation}:${id.toLowerCase()}`;
      nodes.set(nid, {
        id: nid, entityId: id, label: name, kind: relation === 'telemetry' ? 'component' : 'host',
        shape: 'round-hexagon', domain: '', status: verified ? 'Infra' : 'Unverified', volume: 0,
      });
      const eid = `${relation}:${app}:${id}`;
      edges.set(eid, {
        id: eid, source: appNodeId(app), target: nid, relation,
        label: relation === 'telemetry' ? 'sends telemetry to' : verified ? 'runs on · verified ID' : 'reported host · unverified',
        calls: 0, failed: 0, connections: [],
      });
    };
    for (const a of portfolio.apps) {
      for (const id of a.resourceIds) {
        const resource = portfolio.registrations.find((r) => r.resource.id === id)?.resource;
        linkResource(a.id, id, resource?.name || id.split('/').at(-1) || id, 'telemetry', true);
      }
      for (const h of a.hosts) if (h.resourceId && h.state !== 'invalid') {
        linkResource(a.id, h.resourceId, h.resource?.name || h.resourceId.split('/').at(-1) || h.resourceId,
          'hosting', h.state === 'verified');
      }
    }
    for (const r of portfolio.registrations.filter((r) => !r.roles.length)) {
      const nid = `telemetry:${r.resource.id}`;
      nodes.set(nid, {
        id: nid, entityId: r.resource.id, label: `${r.resource.name}\nregistered · no observed role`,
        kind: 'component', shape: 'round-hexagon', domain: r.resource.domain, status: 'Not observed', volume: 0,
      });
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

export function exposure(portfolio: Portfolio, selected: string, direction: 'upstream' | 'downstream'): Set<string> {
  const found = new Set([selected]);
  const queue = [selected];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const c of portfolio.connections) {
      const next = direction === 'upstream'
        ? c.destinationKind === 'service' && c.destination === queue[cursor] ? c.source : null
        : c.source === queue[cursor] && c.destinationKind === 'service' ? c.destination : null;
      if (next && !found.has(next)) { found.add(next); queue.push(next); }
    }
  }
  return found;
}

export function transactionApps(transaction: Transaction | null): Set<string> {
  return new Set(transaction?.spans.map((s) => s.app) ?? []);
}

export function traceConnections(portfolio: Portfolio, transaction: Transaction): Set<string> {
  const ids = new Set<string>();
  for (const span of transaction.spans.filter((s) => s.kind === 'dependency')) {
    const receivers = transaction.spans.filter((s) => s.kind === 'request' && s.parentId === span.spanId);
    for (const c of portfolio.connections) {
      if (c.source === span.app && c.protocol === span.protocol && c.target === span.target &&
          (c.destinationKind === 'target' || receivers.some((r) => r.app === c.destination))) ids.add(c.id);
    }
  }
  return ids;
}

export function overlayTransaction(
  projection: GraphProjection, portfolio: Portfolio, transaction: Transaction,
): GraphProjection {
  const connections = new Map(portfolio.connections.map((c) => [c.id, c]));
  return {
    nodes: projection.nodes.map((n) => {
      const spans = transaction.spans.filter((s) => n.kind === 'service' ? s.app === n.entityId :
        n.kind === 'target' && portfolio.targets.some((t) => t.id === n.entityId && t.target === s.target));
      if (!spans.length) return n;
      return { ...n, status: spans.some((s) => s.success === false) ? 'Error' : 'Healthy' };
    }),
    edges: projection.edges.map((e) => {
      if (e.relation !== 'calls') return e;
      const spans = transaction.spans.filter((s) => s.kind === 'dependency' && e.connections.some((id) => {
        const c = connections.get(id);
        return c && c.source === s.app && c.protocol === s.protocol && c.target === s.target &&
          (c.destinationKind === 'target' || transaction.spans.some((r) =>
            r.kind === 'request' && r.app === c.destination && r.parentId === s.spanId));
      }));
      if (!spans.length) return e;
      const failed = spans.filter((s) => s.success === false).length;
      return { ...e, failed, label: `This trace: ${spans.length} dependency spans${failed ? ` · ${failed} failed` : ''}` };
    }),
  };
}
