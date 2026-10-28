import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchExamples, fetchPortfolio, fetchTransaction } from './api';
import { CatalogManager, type CatalogIntent } from './CatalogManager';
import { EstateGraph } from './EstateGraph';
import { PortfolioOverview } from './PortfolioOverview';
import { MetricsView, TrendCharts, count, duration, percent, timestamp } from './MetricsView';
import { TransactionPanel } from './TransactionPanel';
import { appNodeId, exposure, overlayTransaction, projectGraph, traceConnections, transactionApps } from './graphModel';
import { failureStatus } from '../common/portfolio';
import type {
  AppSummary, DependencyConnection, GraphLens, Portfolio, Transaction, TransactionExample, ViewNode,
} from '../common/portfolio';

type Tab = 'overview' | 'graph' | 'catalog';
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const RANGE_OPTIONS = [1, 6, 24, 168, 720];
const rangeLabel = (n: number) => n < 24 ? `Last ${n}h` : `Last ${n / 24}d`;

export default function App() {
  const [tab, setTab] = useState<Tab>(() => new URLSearchParams(location.search).has('workload') ? 'graph' : 'overview');
  const [hours, setHours] = useState(168);
  const [data, setData] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lens, setLens] = useState<GraphLens>('domains');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<string | null>(() => {
    const app = new URLSearchParams(location.search).get('workload');
    return app ? appNodeId(app) : null;
  });
  const [selectedEdge, setSelectedEdge] = useState(false);
  const [impact, setImpact] = useState<'none' | 'upstream' | 'downstream'>('none');
  const [domain, setDomain] = useState('');
  const [owner, setOwner] = useState('');
  const [tier, setTier] = useState('');
  const [query, setQuery] = useState('');
  const [intent, setIntent] = useState<CatalogIntent | null>(null);
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [transactionLoading, setTransactionLoading] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [selectedSpan, setSelectedSpan] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const traceSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    ++traceSequence.current;
    setLoading(true);
    setError(null);
    setTransaction(null);
    setSelectedSpan(null);
    setTransactionLoading(false);
    setTraceError(null);
    try { const result = await fetchPortfolio(hours); if (sequence === loadSequence.current) setData(result); }
    catch (e) { if (sequence === loadSequence.current) { setData(null); setError(message(e)); } }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }, [hours]);
  useEffect(() => { void load(); }, [load]);
  const openApp = (id: string) => { setTab('graph'); setSelection(appNodeId(id)); setSelectedEdge(false); };
  const selectedApp = data?.apps.find((a) => appNodeId(a.id) === selection) ?? null;
  const filtered = useMemo(() => data?.apps.filter((a) =>
    (!domain || a.domain === domain) && (!owner || a.owner === owner) && (!tier || a.criticality === tier) &&
    (!query || `${a.name} ${a.id} ${a.domain} ${a.owner} ${a.catalog?.description || ''}`.toLowerCase().includes(query.toLowerCase()))) ?? [],
  [data, domain, owner, tier, query]);
  const traceApps = useMemo(() => transactionApps(transaction), [transaction]);
  const impacted = useMemo(() => data && selectedApp && impact !== 'none'
    ? exposure(data, selectedApp.id, impact) : null, [data, selectedApp, impact]);
  const revealed = useMemo(() => new Set([
    ...traceApps, ...(impacted ?? []), ...(selectedApp ? [selectedApp.id] : []),
  ]), [traceApps, impacted, selectedApp]);
  const projection = useMemo(() => {
    if (!data) return { nodes: [], edges: [] };
    const graph = projectGraph(data, lens, expanded, revealed);
    return transaction ? overlayTransaction(graph, data, transaction) : graph;
  }, [data, lens, expanded, revealed, transaction]);
  const graphNode = projection.nodes.find((n) => n.id === selection) ?? null;
  const graphEdge = projection.edges.find((e) => e.id === selection) ?? null;
  const selectedConnections = data?.connections.filter((c) => graphEdge?.connections.includes(c.id)) ?? [];
  const tracedEdges = useMemo(() => data && transaction ? traceConnections(data, transaction) : null, [data, transaction]);
  const focused = transaction ? traceApps : impacted ??
    (domain || owner || tier || query ? new Set(filtered.map((a) => a.id)) : null);
  const selectGraph = (id: string, edge: boolean) => {
    if (edge && data && lens === 'domains') {
      setExpanded((prior) => new Set([
        ...prior, ...data.apps.filter((a) => revealed.has(a.id)).map((a) => a.domain || 'Unclassified'),
      ]));
    }
    setSelection(id);
    setSelectedEdge(edge);
  };
  const openTransaction = async (id: string) => {
    if (!data) return;
    const sequence = ++traceSequence.current;
    setTraceError(null);
    setTransactionLoading(true);
    try {
      const result = await fetchTransaction(data.window, id);
      if (sequence === traceSequence.current) { setTransaction(result); setSelectedSpan(null); setTab('graph'); setImpact('none'); }
    } catch (e) { if (sequence === traceSequence.current) setTraceError(message(e)); }
    finally { if (sequence === traceSequence.current) setTransactionLoading(false); }
  };
  const toggleDomain = (name: string) => {
    const open = projection.nodes.some((n) => n.kind === 'domain' && n.entityId === name && n.expanded);
    setExpanded((prior) => {
      const next = new Set(prior);
      if (open) next.delete(name); else next.add(name);
      return next;
    });
    if (open) { setSelection(null); setSelectedEdge(false); setImpact('none'); }
  };
  const catalogNodes = data?.apps.map((a) => ({
    id: a.id, kind: 'service', domain: a.domain, owner: a.owner, criticality: a.criticality,
  })) ?? [];

  return <div className="app">
    <header className="topbar">
      <div className="brand"><span className="logo" aria-hidden="true">◉</span><div className="title">
        <strong>Estate Atlas</strong><span className="subtitle">Portfolio · observed dependencies · operational context</span>
      </div></div>
      <nav className="tabs" aria-label="Catalog views">{(['overview', 'graph', 'catalog'] as const).map((t) =>
        <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
          {t === 'overview' ? 'Overview' : t === 'graph' ? 'Graph' : 'Catalog'}
        </button>)}</nav>
      <div className="controls">
        <select aria-label="Observation range" value={hours} onChange={(e) => setHours(Number(e.target.value))} disabled={loading}>
          {RANGE_OPTIONS.map((n) => <option key={n} value={n}>{rangeLabel(n)}</option>)}
        </select>
        <button onClick={() => void load()} disabled={loading}>{loading ? 'Querying…' : 'Refresh'}</button>
      </div>
    </header>
    {error && <div role="alert" className="banner error">{error}</div>}
    {data?.warnings.map((w) => <div key={w} role="alert" className="banner warn">{w}</div>)}
    {loading && <div className="banner">Query in progress. Existing values retain their previous observation window.</div>}
    {data && tab !== 'catalog' && <>
      <div className="observation-banner">
        <span><strong>Observation window:</strong> {timestamp(data.window.start)} – {timestamp(data.window.end)}</span>
        <span>Query completed {timestamp(data.generatedAt)}</span>
        <span><strong>Latest event:</strong> {timestamp(data.apps.map((a) => a.lastSeen).filter((t): t is string => Boolean(t)).sort().at(-1) ?? null)}</span>
        <small>Historical observations are not current uptime. No traffic is not proof of an outage. Prior comparison uses the preceding equal-length window; retention is 30 days.</small>
      </div>
      <div className="portfolio-filters">
        <input aria-label="Search applications" placeholder="Search apps, owners, descriptions…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select aria-label="Filter domain" value={domain} onChange={(e) => setDomain(e.target.value)}>
          <option value="">All domains</option>{[...new Set(data.apps.map((a) => a.domain).filter(Boolean))].sort().map((d) => <option key={d}>{d}</option>)}
        </select>
        <select aria-label="Filter owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">All owners</option>{[...new Set(data.apps.map((a) => a.owner).filter(Boolean))].sort().map((o) => <option key={o}>{o}</option>)}
        </select>
        <select aria-label="Filter criticality" value={tier} onChange={(e) => setTier(e.target.value)}>
          <option value="">All criticalities</option>{[...new Set(data.apps.map((a) => a.criticality).filter(Boolean))].sort().map((t) => <option key={t}>{t}</option>)}
        </select>
        <span>{filtered.length} / {data.apps.length} apps · graph retains context</span>
        {(domain || owner || tier || query) && <button onClick={() => { setDomain(''); setOwner(''); setTier(''); setQuery(''); }}>Clear filters</button>}
      </div>
    </>}
    {!data && tab !== 'catalog' && <main className="center">{loading ? 'Reading portfolio evidence…' : 'Portfolio unavailable. Inspect the error above and retry.'}</main>}
    {data && tab === 'overview' && <PortfolioOverview data={data} apps={filtered} onSelect={openApp} />}
    {tab === 'catalog' && <CatalogManager nodes={catalogNodes} intent={intent}
      onIntentHandled={() => setIntent(null)} onChanged={() => void load()} />}
    {data && tab === 'graph' && <>
      <div className="graph-toolbar">
        <label>View <select aria-label="Graph lens" value={lens} onChange={(e) => {
          setLens(e.target.value === 'resources' ? 'resources' : e.target.value === 'applications' ? 'applications' : 'domains');
          setSelectedEdge(false); setSelection(null);
        }}><option value="domains">Domains</option><option value="applications">Applications</option><option value="resources">Resources</option></select></label>
        {lens === 'domains' && <><button onClick={() => setExpanded(new Set(data.groups.filter((g) => g.kind === 'domain').map((g) => g.name)))}>Expand all</button>
          <button onClick={() => { setExpanded(new Set()); setSelection(null); setImpact('none'); setTransaction(null); }}>Collapse all</button>
          {data.groups.filter((g) => g.kind === 'domain').map((g) => {
            const open = projection.nodes.some((n) => n.kind === 'domain' && n.entityId === g.name && n.expanded);
            return <button key={g.name} aria-pressed={Boolean(open)} disabled={Boolean(transaction)}
              onClick={() => toggleDomain(g.name)}>{open ? 'Collapse' : 'Expand'} {g.name}</button>;
          })}</>}
        <span className="relation-legend">Solid: calls · Dashed: telemetry destination · Dotted: reported hosting</span>
        <span className="relation-legend">Fill: green Healthy · amber Warning · red Error · gray unobserved/infrastructure. Rings: domain.</span>
        {transaction && <strong>Actual trace colors/counts · filters do not hide trace context</strong>}
      </div>
      <div className="graph-workspace">
        <main className="graph-pane">
          <EstateGraph projection={projection} selected={selection} emphasizedApps={focused} traceEdges={tracedEdges}
            query={focused ? '' : query} onSelect={selectGraph} />
          <div className="graph-access">
            <label>Inspect app <select aria-label="Select application in graph" value={selectedApp?.id ?? ''} onChange={(e) => e.target.value && openApp(e.target.value)}>
              <option value="">Select…</option>{filtered.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select></label>
            <label>Inspect connection <select aria-label="Select connection in graph" value={selectedEdge ? selection ?? '' : ''} onChange={(e) => {
              if (e.target.value) selectGraph(e.target.value, true);
            }}><option value="">Select…</option>{projection.edges.map((e) => <option key={e.id} value={e.id}>
              {projection.nodes.find((n) => n.id === e.source)?.label.replace(/\n/g, ' ')} → {projection.nodes.find((n) => n.id === e.target)?.label.replace(/\n/g, ' ')} · {e.relation}
            </option>)}</select></label>
          </div>
        </main>
        <aside className="detail-pane portfolio-detail">
          {selectedEdge && graphEdge ? <>
            <h2>Connection evidence</h2><p>{graphEdge.label}</p>
            {graphEdge.relation !== 'calls' && <p className="note">This is resource context, not a workload call. It does not contribute to request volume or impact traversal.</p>}
            {selectedConnections.map((c) => <ConnectionDetail key={c.id} connection={c} />)}
            {graphEdge.relation === 'calls' && selectedConnections.length > 1 && <p className="note">Individual connection P95s are shown above; no average percentile is invented for this grouped edge.</p>}
            {selectedConnections[0] && <><button onClick={() => openApp(selectedConnections[0].source)}>Inspect caller and transaction examples</button></>}
          </> : selectedApp ? <>
            <ServiceDetail app={selectedApp} data={data} onCatalog={() => {
              setIntent({ action: selectedApp.catalog ? 'edit' : 'add', workload: selectedApp.id }); setTab('catalog');
            }} onSelectApp={openApp} />
            <div className="impact-controls"><h3>Potential dependency exposure</h3>
              <button className={impact === 'upstream' ? 'primary' : ''} onClick={() => setImpact(impact === 'upstream' ? 'none' : 'upstream')}>Upstream consumers</button>
              <button className={impact === 'downstream' ? 'primary' : ''} onClick={() => setImpact(impact === 'downstream' ? 'none' : 'downstream')}>Downstream services</button>
              {impacted && <><p>{impacted.size - 1} reachable apps · {data.apps.filter((a) => impacted.has(a.id) && a.id !== selectedApp.id && a.criticality === 'tier1').length} tier1 · {[...new Set(data.apps.filter((a) => impacted.has(a.id) && a.id !== selectedApp.id).map((a) => a.domain).filter(Boolean))].length} domains</p>
                <ul>{data.apps.filter((a) => impacted.has(a.id) && a.id !== selectedApp.id).map((a) =>
                  <li key={a.id}><button className="text-button" onClick={() => openApp(a.id)}>{a.name}</button> · {a.owner || 'Owner unknown'} · {a.criticality || 'Not tagged'}</li>)}</ul></>}
              <p className="note">Graph reachability is potential exposure, not proven outage impact or failed customers. Inferred/async edges and missing instrumentation limit conclusions.</p>
            </div>
            <TransactionExamples data={data} app={selectedApp.id} onOpen={(id) => void openTransaction(id)} />
          </> : graphNode ? <GraphNodeDetail node={graphNode} data={data} onToggleDomain={toggleDomain} onSelectApp={openApp} /> :
            <><h2>Explore the estate</h2><p>Choose a domain to expand its apps, select an app for service context, or select a connection for its evidence.</p>
              <p className="note">Domains contain apps; they do not call each other as executable services. Resources without hosting metadata remain explicitly unmapped.</p></>}
        </aside>
      </div>
      {traceError && <div role="alert" className="banner error">{traceError}</div>}
      {transactionLoading && <div className="banner">Retrieving observed spans, exceptions, and warning/error logs…</div>}
      {transaction && <TransactionPanel transaction={transaction} selectedSpan={selectedSpan}
        onSpan={(id, app) => { setSelectedSpan(id); openApp(app); }}
        onReset={() => { setTransaction(null); setSelectedSpan(null); }} />}
    </>}
  </div>;
}

function ConnectionDetail({ connection: c }: { connection: DependencyConnection }) {
  const known = c.current.good + c.current.failed;
  return <article className="connection-detail">
    <h3>{c.source} → {c.destinationKind === 'service' ? c.destination : c.target}</h3>
    <p>{c.protocol} · {c.evidence}</p>
    <dl><dt>Observed calls</dt><dd>{count(c.current.items)}</dd><dt>Failed calls</dt><dd>{count(c.current.failed)}</dd>
      <dt>Failure rate</dt><dd>{percent(known ? 100 * c.current.failed / known : null)}</dd>
      <dt>Caller-side P95</dt><dd>{duration(c.current.p95)}</dd><dt>Last event</dt><dd>{timestamp(c.current.last)}</dd>
      <dt>Full target identity</dt><dd><code>{c.target}</code></dd></dl>
    <p className="note">Caller duration is not queue waiting time or exclusive server time. Producer sends and consumer processing attempts are not interchangeable.</p>
  </article>;
}

function ServiceDetail({ app: a, data, onCatalog, onSelectApp }: {
  app: AppSummary; data: Portfolio; onCatalog: () => void; onSelectApp: (id: string) => void;
}) {
  const catalog = a.catalog;
  const callers = [...new Set(data.connections.filter((c) => c.destinationKind === 'service' && c.destination === a.id).map((c) => c.source))];
  const downstream = data.connections.filter((c) => c.source === a.id);
  return <>
    <h2>{a.name}</h2><code>{a.id}</code>
    <p className="tags"><span className="tag">{failureStatus(a.current)}</span><span className="tag">{a.criticality || 'No criticality'}</span>
      <span className="tag">{catalog?.isActive === false ? 'Catalog inactive' : catalog ? 'Cataloged' : 'Uncataloged'}</span></p>
    <p>{catalog?.description || 'No business description has been recorded.'}</p>
    <h3>Classification · Azure tags</h3><dl><dt>Domain</dt><dd>{a.domain || 'Unclassified'}</dd>
      <dt>Technical owner</dt><dd>{a.owner || 'Not tagged'}</dd><dt>Business owner</dt><dd>{catalog?.businessOwner || 'Not configured'}</dd>
      <dt>On-call</dt><dd>{catalog?.onCall || 'Not configured'}</dd><dt>Last event</dt><dd>{timestamp(a.lastSeen)}</dd></dl>
    <h3>Request-success target</h3><p className={a.target.state === 'below' ? 'bad-text' : ''}>
      {percent(a.target.success)} observed · {a.target.target === null ? a.target.state : `${a.target.target}% target · ${a.target.state}`}
    </p><p className="note">This measures observed request/processing outcomes in this range, not uptime, error budget, or end-to-end business success.</p>
    <div className="links">{catalog && [
      ['App', catalog.appUrl], ['Docs', catalog.docsUrl], ['Runbook', catalog.runbookUrl], ['Repo', catalog.repoUrl],
    ].filter(([, url]) => url).map(([label, url]) => <a key={label} href={url} target="_blank" rel="noreferrer">{label}</a>)}
      {a.resourceIds.map((id) => <a key={id} href={`https://portal.azure.com/#resource${id}/overview`} target="_blank" rel="noreferrer">App Insights</a>)}
    </div><button onClick={onCatalog}>{catalog ? 'Edit catalog entry' : 'Add to catalog'}</button>
    <h3>Observation and comparison</h3><MetricsView current={a.current} previous={a.previous} />
    <TrendCharts points={a.trend} window={data.window} />
    <h3>Direct callers</h3><ul>{callers.map((id) => <li key={id}><button className="text-button" onClick={() => onSelectApp(id)}>{id}</button></li>)}</ul>
    {!callers.length && <p>No callers observed in this range.</p>}
    <h3>Direct dependencies</h3><ul>{downstream.map((c) => <li key={c.id}>
      {c.destinationKind === 'service' ? <button className="text-button" onClick={() => onSelectApp(c.destination)}>{c.destination}</button> : c.target}
      <small>{c.protocol} · {c.evidence} · {count(c.current.failed)} failed</small>
    </li>)}</ul>
    <h3>Hosting · instrumentation metadata</h3>
    {!a.hosts.length && <p>Unavailable: no retained resource-detector metadata. No hosting is inferred from the App Insights destination.</p>}
    {a.hosts.map((h) => <article key={`${h.instance}:${h.componentId}`}>
      <strong>{h.resource?.name || (h.state === 'unavailable' ? 'No hosting identity reported' : h.resourceId)}</strong>
      <small>{h.instance || 'Unknown instance'} · {h.state} · observed {timestamp(h.observedAt)}</small>
      {h.resource && <><p>{h.resource.type} · {h.resource.location}</p>
        <a href={`https://portal.azure.com/#resource${h.resource.id}/overview`} target="_blank" rel="noreferrer">Open verified resource</a></>}
    </article>)}
    <p className="note">The simulator has no real workload hosts. Hosting metadata is telemetry-reported; an exact readable ARM ID verifies resource identity, not ownership or historical placement.</p>
  </>;
}

function GraphNodeDetail({ node, data, onToggleDomain, onSelectApp }: {
  node: ViewNode; data: Portfolio; onToggleDomain: (name: string) => void; onSelectApp: (id: string) => void;
}) {
  if (node.kind === 'domain') {
    const group = data.groups.find((g) => g.kind === 'domain' && g.name === node.entityId);
    return <><h2>{node.entityId}</h2><button onClick={() => onToggleDomain(node.entityId)}>{node.expanded ? 'Collapse domain' : 'Expand domain'}</button>
      <ul>{data.apps.filter((a) => (a.domain || 'Unclassified') === node.entityId).map((a) =>
        <li key={a.id}><button className="text-button" onClick={() => onSelectApp(a.id)}>{a.name}</button> · {a.criticality || 'Not tagged'}</li>)}</ul>
      {group && <><MetricsView current={group.current} previous={group.previous} /><TrendCharts points={group.trend} window={data.window} /></>}
    </>;
  }
  const target = data.targets.find((t) => t.id === node.entityId);
  const resource = data.registrations.find((r) => r.resource.id === node.entityId)?.resource ??
    data.apps.flatMap((a) => a.hosts).find((h) => h.resourceId === node.entityId)?.resource;
  return <><h2>{node.label}</h2><p>{node.kind} · {node.status}</p>
    {target && <><code>{target.target}</code><p>{target.protocol} · {count(target.current.items)} observations · {count(target.current.failed)} failures · {duration(target.current.p95)} P95</p>
      <p className="note">Observed backing target. An exact Azure resource mapping has not been established; the friendly name is not an ARM ID.</p></>}
    {resource && <><p>{resource.type} · {resource.location}</p><a href={`https://portal.azure.com/#resource${resource.id}/overview`} target="_blank" rel="noreferrer">Open Azure resource</a></>}
    {node.kind === 'host' && !resource && <p className="note">Reported host ID could not be verified with current access. This does not prove deletion or downtime.</p>}
  </>;
}

function TransactionExamples({ data, app, onOpen }: { data: Portfolio; app: string; onOpen: (id: string) => void }) {
  const [mode, setMode] = useState<'failed' | 'slow'>('failed');
  const [items, setItems] = useState<TransactionExample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(null); setItems([]);
    fetchExamples(data.window, app, mode).then((result) => {
      if (active) { setItems(result.items); setTruncated(result.truncated); }
    }).catch((e: unknown) => { if (active) setError(message(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [data.window, app, mode]);
  return <section><h3>Actual transaction examples</h3>
    <select aria-label="Transaction examples" value={mode} onChange={(e) => setMode(e.target.value === 'slow' ? 'slow' : 'failed')}>
      <option value="failed">Failed requests/processing</option><option value="slow">Slowest observed requests</option>
    </select>
    {error && <p role="alert" className="bad-text">{error}</p>}
    {loading && <p>Loading transaction examples…</p>}
    {!loading && !items.length && !error && <p>No matching examples in this window.</p>}
    {truncated && <p className="note">Showing the first 50 examples.</p>}
    <ul className="example-list">{items.map((item) => <li key={item.spanId}>
      <button className="text-button" onClick={() => onOpen(item.operationId)}>{item.name} · {duration(item.duration)}</button>
      <small>{timestamp(item.time)} · {item.success === null ? 'Unknown outcome' : item.success ? 'Observed success' : 'Failed'} {item.resultCode}</small>
    </li>)}</ul>
  </section>;
}
