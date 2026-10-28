import { useMemo, useState } from 'react';
import { failureStatus, successPercent } from '../common/portfolio';
import type { AppSummary, GroupSummary, Measures, Portfolio } from '../common/portfolio';
import { count, duration, percent, timestamp } from './MetricsView';

export function PortfolioOverview({ data, apps, onSelect }: {
  data: Portfolio; apps: AppSummary[]; onSelect: (id: string) => void;
}) {
  const [sort, setSort] = useState<'attention' | 'name' | 'failures' | 'latency' | 'volume'>('attention');
  const [grouping, setGrouping] = useState<'domain' | 'owner'>('domain');
  const ordered = useMemo(() => [...apps].sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'failures') return b.current.failed - a.current.failed;
    if (sort === 'latency') return (b.current.p95 ?? -1) - (a.current.p95 ?? -1);
    if (sort === 'volume') return b.current.items - a.current.items;
    return Number(b.target.state === 'below') - Number(a.target.state === 'below') ||
      b.findings.length - a.findings.length || b.current.failed - a.current.failed || a.name.localeCompare(b.name);
  }), [apps, sort]);
  const visible = new Set(apps.map((a) => a.id));
  const groups = data.groups.filter((g) => g.kind === grouping).map((g) => {
    const members = apps.filter((a) => (a[grouping] || 'Unclassified') === g.name);
    if (!members.length) return null;
    const complete = data.apps.filter((a) => (a[grouping] || 'Unclassified') === g.name).every((a) => visible.has(a.id));
    const summary: Measures = complete ? g.current : {
      ...g.current, rows: 0, items: 0, good: 0, failed: 0, unknown: 0, p95: null,
    };
    if (!complete) for (const a of members) {
      for (const field of ['rows', 'items', 'good', 'failed', 'unknown'] as const) summary[field] += a.current[field];
    }
    return { ...g, current: summary, apps: members.length, tier1: members.filter((a) => a.criticality === 'tier1').length, complete };
  }).filter((g): g is GroupSummary & { complete: boolean } => g !== null);
  return <section className="overview">
    <div className="summary-cards">
      <div><strong>{apps.length}</strong><span>apps in current filter</span></div>
      <div><strong>{apps.filter((a) => a.current.rows > 0).length}</strong><span>with request observations</span></div>
      <div><strong>{apps.filter((a) => a.target.state === 'below').length}</strong><span>below success target</span></div>
      <div><strong>{apps.filter((a) => a.findings.length > 0).length}</strong><span>with attention findings</span></div>
      <div><strong>{data.warnings.some((w) => w.startsWith('Registration coverage')) ? 'Unavailable' : data.registrations.length}</strong><span>registered resources · environment scope</span></div>
    </div>
    <div className="section-title"><h2>Portfolio by {grouping}</h2>
      <select aria-label="Group portfolio by" value={grouping} onChange={(e) => setGrouping(e.target.value === 'owner' ? 'owner' : 'domain')}>
        <option value="domain">Domain</option><option value="owner">Owner</option>
      </select>
    </div>
    <div className="table-wrap"><table className="portfolio-table">
      <thead><tr><th>{grouping}</th><th>Apps / tier1</th><th>Operations</th><th>Failed</th><th>Observed success</th><th>P95</th></tr></thead>
      <tbody>{groups.map((g) => <tr key={g.name}>
        <td>{g.name}</td><td>{g.apps} / {g.tier1}</td><td>{count(g.current.items)}</td>
        <td>{count(g.current.failed)}</td><td>{percent(successPercent(g.current))}</td>
        <td>{g.complete ? duration(g.current.p95) : 'Not computed for this filter'}</td>
      </tr>)}</tbody>
    </table></div>
    <p className="note">Success is operation-weighted, not a count of customer journeys. Domain P95 uses underlying
      samples, never averages of app percentiles. A narrowed group omits P95 rather than inventing it.</p>
    <div className="section-title"><h2>Applications and attention</h2>
      <select aria-label="Sort applications" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
        <option value="attention">Attention findings</option><option value="name">Name</option>
        <option value="failures">Failures</option><option value="latency">P95 duration</option><option value="volume">Observed operations</option>
      </select>
    </div>
    <div className="table-wrap"><table className="portfolio-table">
      <thead><tr><th>Application</th><th>Domain / owner</th><th>Criticality</th><th>Operations / failed</th>
        <th>Success / target</th><th>P95 / previous</th><th>Last event</th><th>Attention</th></tr></thead>
      <tbody>{ordered.map((a) => <tr key={a.id}>
        <td><button className="text-button" onClick={() => onSelect(a.id)}>{a.name}</button><small>{a.id}</small></td>
        <td>{a.domain || 'Unclassified'}<small>{a.owner || 'Owner missing'}</small></td>
        <td>{a.criticality || 'Not tagged'}</td><td>{count(a.current.items)} / {count(a.current.failed)}</td>
        <td><span className={a.target.state === 'below' ? 'bad-text' : ''}>{percent(a.target.success)}</span>
          <small>{a.target.target === null ? a.target.state : `${a.target.target}% target · ${a.target.state}`}</small></td>
        <td>{duration(a.current.p95)}<small>previous: {duration(a.previous.p95)}</small></td>
        <td>{timestamp(a.lastSeen)}<small>{failureStatus(a.current)} in selected range</small></td>
        <td>{a.findings.length ? a.findings.join(' · ') : 'Required metadata present'}
          <small>Completeness is not verified readiness</small></td>
      </tr>)}</tbody>
    </table></div>
    <h2>Registration and catalog coverage</h2>
    <p className="note">Coverage below is environment-scoped and is not hidden by app filters. Resources without observed
      roles have unknown service identities; no app name is inferred from an <code>appi-</code> prefix.</p>
    <ul className="coverage-list">
      {data.registrations.map((r) => <li key={r.resource.id}>
        <strong>{r.resource.name}</strong> — {r.roles.length ? `observed roles: ${r.roles.join(', ')}` : 'Registered, no role observed in retained history'}
        {(!r.resource.domain || !r.resource.criticality || !r.resource.owner) && ' · missing classification'}
      </li>)}
      {data.apps.filter((a) => a.catalog && !a.resourceIds.length).map((a) =>
        <li key={a.id}><button className="text-button" onClick={() => onSelect(a.id)}>{a.name}</button> — catalog-only; no observed resource mapping</li>)}
    </ul>
  </section>;
}
