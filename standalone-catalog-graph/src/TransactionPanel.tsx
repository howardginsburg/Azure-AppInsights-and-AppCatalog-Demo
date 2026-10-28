import type { Transaction } from '../common/portfolio';
import { duration, timestamp } from './MetricsView';

export function TransactionPanel({ transaction, selectedSpan, onSpan, onReset }: {
  transaction: Transaction; selectedSpan: string | null;
  onSpan: (id: string, app: string) => void; onReset: () => void;
}) {
  const start = Math.min(...transaction.spans.map((s) => Date.parse(s.time)));
  const end = Math.max(...transaction.spans.map((s) => Date.parse(s.time) + s.duration));
  const spanIds = new Set(transaction.spans.map((s) => s.spanId));
  const roots = transaction.spans.filter((s) => s.kind === 'request' && (!s.parentId || s.parentId === transaction.operationId));
  const failed = transaction.spans.filter((s) => s.success === false);
  return <section className="transaction-panel">
    <div className="section-title"><div><h2>Actual transaction</h2><code>{transaction.operationId}</code></div>
      <button onClick={onReset}>Clear overlay</button></div>
    <p>{transaction.spans.length} spans · {failed.length} failed · {roots.some((s) => s.success) && failed.length
      ? 'Successful root request with downstream failure' : 'Inspect observed outcomes below'}</p>
    <p className="note">Portfolio filters do not hide transaction context. Bars show observed span placement and
      duration, not a sum of nested execution time or proof of customer wait.</p>
    {transaction.warnings.map((w) => <p key={w} className="note warning">{w}</p>)}
    <div className="table-wrap"><table className="trace-table">
      <thead><tr><th>Span / application</th><th>Kind / target</th><th>Start +ms</th><th>Duration / placement</th><th>Outcome</th></tr></thead>
      <tbody>{transaction.spans.map((s) => {
        const offset = Date.parse(s.time) - start;
        const missing = s.parentId && s.parentId !== transaction.operationId && !spanIds.has(s.parentId);
        return <tr key={`${s.app}:${s.spanId}:${s.kind}`} className={selectedSpan === s.spanId ? 'selected-row' : ''}>
          <td><button className="text-button" onClick={() => onSpan(s.spanId, s.app)}>{s.name}</button>
            <small>{s.app}</small><small>{s.spanId}{missing ? ' · parent not retrieved' : ''}</small></td>
          <td>{s.kind}{s.protocol && ` · ${s.protocol}`}<small>{s.target}</small></td>
          <td>{offset.toFixed(1)}</td>
          <td>{duration(s.duration)}<div className="duration-track">
            <span className={s.success === false ? 'failed-bar' : ''} style={{
              marginLeft: `${100 * offset / Math.max(1, end - start)}%`,
              width: `${Math.max(0.5, 100 * s.duration / Math.max(1, end - start))}%`,
            }} />
          </div></td>
          <td className={s.success === false ? 'bad-text' : ''}>{s.success === null ? 'Unknown' : s.success ? 'Success' : 'Failed'} {s.resultCode}</td>
        </tr>;
      })}</tbody>
    </table></div>
    <h3>Correlated exceptions and warning/error logs</h3>
    <div className="trace-events">{transaction.events.map((e, i) => <article
      key={`${e.kind}:${e.app}:${i}`} className={selectedSpan === e.parentId ? 'selected-row' : ''}>
      <strong>{e.kind} · {e.app}</strong><small>{timestamp(e.time)} · parent {e.parentId || 'unavailable'}</small>
      {e.type && <code>{e.type}</code>}<p>{e.message}</p>
    </article>)}
      {!transaction.events.length && <p>No warning/error logs or exceptions were observed in this operation/window.</p>}
    </div>
  </section>;
}
