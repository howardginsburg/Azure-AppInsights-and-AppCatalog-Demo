import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchEstate } from './api';
import { EstateGraph } from './EstateGraph';
import { CatalogManager, type CatalogIntent } from './CatalogManager';
import { HEALTH_LEGEND, domainPalette } from './colors';
import type { EstateGraph as EstateGraphData, GraphNode } from '../common/shared';

const RANGE_OPTIONS = [
  { label: 'Last 1h', hours: 1 },
  { label: 'Last 6h', hours: 6 },
  { label: 'Last 24h', hours: 24 },
  { label: 'Last 7d', hours: 168 },
  { label: 'Last 30d', hours: 720 },
];

type Tab = 'graph' | 'catalog';

/** The app the page was opened for, from a workbook "Open in catalog" link. */
function deepLinkedWorkload(): string | null {
  return new URLSearchParams(window.location.search).get('workload')?.trim() || null;
}

export default function App() {
  const [tab, setTab] = useState<Tab>('graph');
  // Default to 7 days so the graph renders even when recent telemetry is sparse.
  const [rangeHours, setRangeHours] = useState(168);
  const [graph, setGraph] = useState<EstateGraphData | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusDomain, setFocusDomain] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [pendingWorkload, setPendingWorkload] = useState<string | null>(deepLinkedWorkload);
  const [catalogIntent, setCatalogIntent] = useState<CatalogIntent | null>(null);

  const load = useCallback(async (hours: number) => {
    setLoading(true);
    setError(null);
    try {
      setGraph(await fetchEstate(hours));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setGraph(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(rangeHours);
  }, [rangeHours, load]);

  // Resolve a deep link once data arrives: select the app in the graph, or fall back to its
  // catalog entry when it sent no telemetry in the time range.
  useEffect(() => {
    if (!pendingWorkload || loading || (!graph && !error)) return;
    const node = graph?.nodes.find((n) => n.id.toLowerCase() === pendingWorkload.toLowerCase());
    if (node) {
      setSelected(node);
      setQuery(node.id);
    } else {
      setCatalogIntent({ action: 'edit', workload: pendingWorkload });
      setTab('catalog');
    }
    setPendingWorkload(null);
  }, [pendingWorkload, graph, loading, error]);

  const nodes = useMemo(() => graph?.nodes ?? [], [graph]);
  const services = useMemo(() => nodes.filter((n) => n.kind === 'service'), [nodes]);
  const palette = useMemo(() => domainPalette(services.map((n) => n.domain)), [services]);
  const domains = useMemo(() => [...palette.keys()], [palette]);

  const stats = useMemo(() => {
    if (!graph) return null;
    return {
      apps: services.length,
      cataloged: services.filter((n) => n.cataloged).length,
      untagged: services.filter((n) => !n.tagged).length,
      errors: nodes.filter((n) => n.status === 'Error').length,
      warnings: nodes.filter((n) => n.status === 'Warning').length,
    };
  }, [graph, nodes, services]);

  const openCatalog = useCallback((intent: CatalogIntent) => {
    setCatalogIntent(intent);
    setTab('catalog');
  }, []);

  const clearIntent = useCallback(() => setCatalogIntent(null), []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◉</span>
          <div className="title">
            <strong>Estate Atlas</strong>
            <span className="subtitle">live topology from Log Analytics · tags from Azure · business context from the catalog</span>
          </div>
        </div>
        <nav className="tabs">
          <button className={tab === 'graph' ? 'active' : ''} onClick={() => setTab('graph')}>
            Estate graph
          </button>
          <button className={tab === 'catalog' ? 'active' : ''} onClick={() => setTab('catalog')}>
            Catalog
          </button>
        </nav>
        {tab === 'graph' && (
          <div className="controls">
            <select value={rangeHours} onChange={(e) => setRangeHours(Number(e.target.value))} disabled={loading}>
              {RANGE_OPTIONS.map((o) => (
                <option key={o.hours} value={o.hours}>{o.label}</option>
              ))}
            </select>
            <button onClick={() => void load(rangeHours)} disabled={loading}>
              {loading ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>
        )}
      </header>

      {error && <div className="banner error">{error}</div>}
      {graph?.warnings.map((w) => (
        <div key={w} className="banner warn">{w}</div>
      ))}

      {tab === 'graph' ? (
        <div className="graph-shell">
          <div className="graph-focusbar">
            <span className="focus-label">Focus</span>
            <button className={focusDomain === null ? 'chip active' : 'chip'} onClick={() => setFocusDomain(null)}>
              All domains
            </button>
            {domains.map((d) => (
              <button
                key={d}
                className={focusDomain === d ? 'chip active' : 'chip'}
                onClick={() => setFocusDomain(focusDomain === d ? null : d)}
              >
                {d}
              </button>
            ))}
            <input
              className="search"
              placeholder="Search apps…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {stats && (
              <div className="statbar">
                <Stat label="apps" value={stats.apps} />
                <Stat label="cataloged" value={stats.cataloged} />
                <Stat label="untagged" value={stats.untagged} tone={stats.untagged ? 'warn' : undefined} />
                <Stat label="errors" value={stats.errors} tone={stats.errors ? 'error' : undefined} />
                <Stat label="warnings" value={stats.warnings} tone={stats.warnings ? 'warn' : undefined} />
              </div>
            )}
          </div>

          <div className="body">
            <main className="graph-pane">
              {graph && graph.nodes.length > 0 ? (
                <EstateGraph
                  nodes={graph.nodes}
                  edges={graph.edges}
                  palette={palette}
                  onSelect={setSelected}
                  focusDomain={focusDomain}
                  query={query}
                />
              ) : (
                <div className="center muted">
                  {loading ? 'Querying Log Analytics…' : 'No telemetry in this range. Widen the range or start the simulator.'}
                </div>
              )}
              <Legend palette={palette} />
            </main>

            <aside className="detail-pane">
              {selected ? (
                <NodeCard node={selected} onCatalog={openCatalog} />
              ) : (
                <div className="muted detail-empty">
                  <p>Select an app to see its tags, catalog entry, and live telemetry.</p>
                  <p className="hint">Hover an app to spotlight its dependencies. Use the domain chips or search to focus.</p>
                </div>
              )}
            </aside>
          </div>
        </div>
      ) : (
        <CatalogManager nodes={nodes} intent={catalogIntent} onIntentHandled={clearIntent} />
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'error' | 'warn' }) {
  return (
    <div className={`stat${tone ? ' ' + tone : ''}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function Legend({ palette }: { palette: Map<string, string> }) {
  return (
    <div className="legend">
      <div className="legend-group">
        <span className="legend-title">fill = health</span>
        {HEALTH_LEGEND.map((i) => (
          <span key={i.label} className="legend-item">
            <span className="dot" style={{ background: i.color }} />
            {i.label}
          </span>
        ))}
      </div>
      {palette.size > 0 && (
        <div className="legend-group">
          <span className="legend-title">ring = domain</span>
          {[...palette].map(([domain, color]) => (
            <span key={domain} className="legend-item">
              <span className="ring" style={{ borderColor: color }} />
              {domain}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function NodeCard({ node, onCatalog }: { node: GraphNode; onCatalog: (intent: CatalogIntent) => void }) {
  const isService = node.kind === 'service';
  const links = [
    { label: 'App', href: node.appUrl },
    { label: 'Docs', href: node.docsUrl },
    { label: 'Runbook', href: node.runbookUrl },
    { label: 'Repo', href: node.repoUrl },
    {
      label: 'App Insights',
      href: node.resourceId ? `https://portal.azure.com/#resource${node.resourceId}/overview` : null,
    },
  ].filter((l) => l.href);

  return (
    <div className="node-card">
      <h2>{node.name}</h2>
      {node.name !== node.id && <div className="muted node-id"><code>{node.id}</code></div>}
      <div className="tags">
        <span className="tag">{node.kind}</span>
        <span className={`tag status-${node.status.toLowerCase()}`}>{node.status}</span>
        {isService && !node.tagged && <span className="tag warn-tag">untagged</span>}
        {isService && !node.cataloged && <span className="tag muted-tag">uncataloged</span>}
      </div>

      {isService && (
        <>
          <h3>Classification · Azure tags</h3>
          <dl>
            <dt>Domain</dt>
            <dd>{node.domain || '—'}</dd>
            <dt>Criticality</dt>
            <dd>{node.criticality || '—'}</dd>
            <dt>Owner</dt>
            <dd>{node.owner || '—'}</dd>
          </dl>
          {!node.tagged && (
            <p className="note">
              Add <code>domain</code>, <code>criticality</code>, and <code>owner</code> tags to this app's
              Application Insights resource.
            </p>
          )}

          <h3>Business context · catalog</h3>
          {node.cataloged ? (
            <dl>
              <dt>Business owner</dt>
              <dd>{node.businessOwner || '—'}</dd>
              <dt>SLO</dt>
              <dd>{node.slo ? `${node.slo}%` : '—'}</dd>
              <dt>On-call</dt>
              <dd>{node.onCall || '—'}</dd>
            </dl>
          ) : (
            <p className="note">Not in the catalog yet.</p>
          )}
        </>
      )}

      <h3>Live telemetry</h3>
      <dl>
        <dt>Calls</dt>
        <dd>{node.calls.toLocaleString()}</dd>
        <dt>Failures</dt>
        <dd>{node.fails.toLocaleString()} ({node.failPct}%)</dd>
        <dt>P95</dt>
        <dd>{node.p95} ms</dd>
      </dl>

      {links.length > 0 && (
        <div className="links">
          {links.map((l) => (
            <a key={l.label} href={l.href!} target="_blank" rel="noreferrer">{l.label}</a>
          ))}
        </div>
      )}

      {isService && (
        <div className="card-actions">
          <button
            className="primary"
            onClick={() => onCatalog({ action: node.cataloged ? 'edit' : 'add', workload: node.id })}
          >
            {node.cataloged ? 'Edit catalog entry' : 'Add to catalog'}
          </button>
        </div>
      )}
    </div>
  );
}
