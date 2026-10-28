import { latencyChange, successPercent } from '../common/portfolio';
import type { Measures, QueryWindow, TrendPoint } from '../common/portfolio';

export const count = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 0 });
export const duration = (value: number | null) => value === null ? 'Not observed' : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms`;
export const percent = (value: number | null) => value === null ? 'Not observed' : `${value.toFixed(2)}%`;
export const timestamp = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not observed in retained history';

export function MetricsView({ current, previous }: { current: Measures; previous: Measures }) {
  const delta = latencyChange(current, previous);
  return <>
    <dl className="measure-grid">
      <dt>Observed operations</dt><dd>{count(current.items)} <small>({count(current.rows)} stored samples)</small></dd>
      <dt>Failed operations</dt><dd>{count(current.failed)}</dd>
      <dt>Unknown outcome</dt><dd>{count(current.unknown)}</dd>
      <dt>Request/processing success</dt><dd>{percent(successPercent(current))}</dd>
      <dt>P95 duration</dt><dd>{duration(current.p95)}</dd>
      <dt>Previous P95</dt><dd>{duration(previous.p95)}</dd>
      <dt>P95 change</dt><dd>{delta.absolute === null ? 'Insufficient history' :
        `${delta.absolute > 0 ? '+' : ''}${delta.absolute.toFixed(1)} ms` +
        (delta.relative === null ? ' (relative change undefined)' : ` (${delta.relative > 0 ? '+' : ''}${delta.relative.toFixed(1)}%)`)}</dd>
      <dt>Selected event range</dt><dd>{current.first ? `${timestamp(current.first)} – ${timestamp(current.last)}` : 'No observations'}</dd>
      <dt>Previous samples</dt><dd>{count(previous.rows)}</dd>
      <dt>Previous event range</dt><dd>{previous.first ? `${timestamp(previous.first)} – ${timestamp(previous.last)}` : 'No baseline observations'}</dd>
    </dl>
    <p className="note">Latency changes are descriptive, not a deployment/regression verdict. Sparse history,
      different traffic mix, or changing sampling can affect comparisons. Duration excludes queue backlog.</p>
  </>;
}

export function TrendCharts({ points, window }: { points: TrendPoint[]; window: QueryWindow }) {
  const start = Date.parse(window.start);
  const buckets = Math.ceil(window.hours * 60 / window.binMinutes);
  const byTime = new Map(points.map((p) => [Date.parse(p.time), p]));
  return <div className="trend-charts">
    {(['items', 'failure', 'p95'] as const).map((field) => {
      const label = field === 'items' ? 'Observed operations' : field === 'failure' ? 'Failure rate (%)' : 'P95 duration (ms)';
      const values = Array.from({ length: buckets }, (_, i) => {
        const p = byTime.get(start + i * window.binMinutes * 60_000);
        if (!p) return null;
        if (field === 'items') return p.items;
        if (field === 'p95') return p.p95;
        const known = p.good + p.failed;
        return known ? 100 * p.failed / known : null;
      });
      const observations = values.filter((v): v is number => v !== null);
      const peak = observations.length ? Math.max(...observations) : null;
      const maximum = Math.max(1, peak ?? 0);
      let path = '', prior = false;
      values.forEach((value, i) => {
        if (value === null) { prior = false; return; }
        path += `${prior ? ' L' : ' M'}${8 + i * 284 / Math.max(1, buckets - 1)},${76 - 64 * value / maximum}`;
        prior = true;
      });
      return <figure key={field}>
        <figcaption>{label}</figcaption>
        <svg viewBox="0 0 300 88" role="img" aria-label={`${label} over the selected range; gaps indicate no observations`}>
          <path d="M8,78 H292" stroke="#435268" fill="none" />
          <path d={path} stroke={field === 'failure' ? '#f0a575' : '#58cdb4'} fill="none" strokeWidth="2" />
        </svg>
        <small>{peak === null ? 'No observations' : `Peak ${peak.toFixed(1)}`} · {observations.length}/{buckets} populated buckets</small>
      </figure>;
    })}
  </div>;
}
