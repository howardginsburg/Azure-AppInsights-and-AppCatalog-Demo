import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { CatalogInput, CatalogModel, GraphNode } from '../common/shared';
import { createCatalog, deleteCatalog, fetchCatalog, updateCatalog } from './api';

/** A request from the graph view to add or edit the catalog entry for one app. */
export interface CatalogIntent {
  action: 'add' | 'edit';
  workload: string;
}

const EMPTY: CatalogInput = {
  workload: '',
  displayName: '',
  businessOwner: '',
  description: '',
  appUrl: '',
  docsUrl: '',
  runbookUrl: '',
  repoUrl: '',
  slo: '',
  onCall: '',
  isActive: true,
};

export function CatalogManager({
  nodes,
  intent,
  onIntentHandled,
  onChanged,
}: {
  /** Graph nodes, used to show each app's tags. */
  nodes: Pick<GraphNode, 'kind' | 'id' | 'domain' | 'criticality' | 'owner'>[];
  intent: CatalogIntent | null;
  onIntentHandled: () => void;
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<CatalogModel[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<CatalogModel | 'new' | null>(null);
  const [prefill, setPrefill] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchCatalog());
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Open the form the graph view asked for once the catalog has loaded.
  useEffect(() => {
    if (!intent || !loaded) return;
    setFilter(intent.workload);
    const existing = rows.find((r) => r.workload.toLowerCase() === intent.workload.toLowerCase());
    if (existing) {
      setEditing(existing);
    } else if (intent.action === 'add') {
      setPrefill(intent.workload);
      setEditing('new');
    }
    onIntentHandled();
  }, [intent, loaded, rows, onIntentHandled]);

  const tagsById = useMemo(() => {
    const map = new Map<string, Pick<GraphNode, 'kind' | 'id' | 'domain' | 'criticality' | 'owner'>>();
    for (const n of nodes) if (n.kind === 'service') map.set(n.id.toLowerCase(), n);
    return map;
  }, [nodes]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const t = tagsById.get(r.workload.toLowerCase());
      return `${r.displayName} ${r.workload} ${r.businessOwner} ${t?.domain ?? ''} ${t?.owner ?? ''}`
        .toLowerCase()
        .includes(q);
    });
  }, [rows, filter, tagsById]);

  const save = useCallback(
    async (input: CatalogInput, id: string | null) => {
      setBusy(true);
      setError(null);
      try {
        if (id) await updateCatalog(id, input);
        else await createCatalog(input);
        setEditing(null);
        await load();
        onChanged?.();
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      } finally {
        setBusy(false);
      }
    },
    [load, onChanged],
  );

  const remove = useCallback(
    async (row: CatalogModel) => {
      if (!window.confirm(`Delete the catalog entry for "${row.displayName}" (${row.workload})?`)) return;
      setBusy(true);
      setError(null);
      try {
        await deleteCatalog(row.id);
        await load();
        onChanged?.();
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      } finally {
        setBusy(false);
      }
    },
    [load, onChanged],
  );

  return (
    <div className="catalog-view">
      <div className="catalog-toolbar">
        <input
          className="search"
          placeholder="Filter catalog…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="count">{visible.length} of {rows.length}</span>
        <div className="spacer" />
        <button
          className="primary"
          onClick={() => {
            setPrefill('');
            setEditing('new');
          }}
          disabled={busy}
        >
          + Add app
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="table-wrap">
        <table className="catalog-table">
          <thead>
            <tr>
              <th>App</th>
              <th>Service name</th>
              <th>Domain</th>
              <th>Criticality</th>
              <th>Owner</th>
              <th>Request-success target</th>
              <th>Active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const t = tagsById.get(r.workload.toLowerCase());
              return (
                <tr key={r.id} className={r.isActive ? '' : 'inactive'}>
                  <td>
                    <div className="svc-name">{r.displayName}</div>
                    <div className="svc-desc">{r.description}</div>
                  </td>
                  <td><code>{r.workload}</code></td>
                  <td>{t?.domain || '—'}</td>
                  <td>{t?.criticality ? <span className={`tier tier-${t.criticality}`}>{t.criticality}</span> : '—'}</td>
                  <td>{t?.owner || '—'}</td>
                  <td>{r.slo ? `${r.slo}%` : '—'}</td>
                  <td>{r.isActive ? '✓' : '—'}</td>
                  <td className="row-actions">
                    <button onClick={() => setEditing(r)} disabled={busy}>Edit</button>
                    <button className="danger" onClick={() => void remove(r)} disabled={busy}>
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
            {!loading && visible.length === 0 && (
              <tr>
                <td colSpan={8} className="empty">
                  {rows.length === 0 ? 'No catalog entries yet. Add one, or select an app in the graph.' : 'No matches.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {loading && <div className="muted center-pad">Loading catalog…</div>}
        <p className="muted table-note">
          Domain, criticality, and owner come from each app's Application Insights tags. They show
          here when retained telemetry establishes a service-to-resource mapping. A blank value
          is not proof that the Azure resource has no tags.
        </p>
      </div>

      {editing && (
        <CatalogForm
          initial={editing === 'new' ? null : editing}
          prefillWorkload={prefill}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(input) => void save(input, editing === 'new' ? null : editing.id)}
        />
      )}
    </div>
  );
}

function CatalogForm({
  initial,
  prefillWorkload,
  busy,
  onCancel,
  onSave,
}: {
  initial: CatalogModel | null;
  prefillWorkload: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (input: CatalogInput) => void;
}) {
  const [form, setForm] = useState<CatalogInput>(() =>
    initial
      ? { ...initial }
      : { ...EMPTY, workload: prefillWorkload, displayName: prefillWorkload },
  );

  const set = <K extends keyof CatalogInput>(k: K, v: CatalogInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave(form);
  };

  const field = (
    label: string,
    key: keyof CatalogInput,
    opts: { type?: string; placeholder?: string; full?: boolean; required?: boolean } = {},
  ) => (
    <label className={opts.full ? 'full' : ''}>
      <span>{label}</span>
      <input
        type={opts.type ?? 'text'}
        step={opts.type === 'number' ? 'any' : undefined}
        min={opts.type === 'number' ? 0 : undefined}
        max={opts.type === 'number' ? 100 : undefined}
        placeholder={opts.placeholder}
        value={String(form[key] ?? '')}
        required={opts.required}
        onChange={(e) => set(key, e.target.value as CatalogInput[typeof key])}
      />
    </label>
  );

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{initial ? 'Edit catalog entry' : 'Add to catalog'}</h2>
        <p className="form-note">
          Domain, criticality, and owner come from the app's Application Insights tags. The catalog
          holds business context. The percentage is a selected-range request/processing-success
          target, not uptime or a rolling error budget.
        </p>
        <div className="form-grid">
          <label>
            <span>Service name *</span>
            <input
              value={form.workload}
              placeholder="orders-api (its OTEL_SERVICE_NAME)"
              onChange={(e) => set('workload', e.target.value)}
              disabled={Boolean(initial)}
              required
            />
          </label>
          {field('Display name *', 'displayName', { placeholder: 'Orders API', required: true })}
          {field('Business owner', 'businessOwner', { placeholder: 'VP Digital Commerce' })}
          {field('Request-success target (%)', 'slo', { placeholder: '99.9', type: 'number' })}
          {field('On-call', 'onCall', { placeholder: 'team-oncall@contoso.example', full: true })}
          {field('Description', 'description', { full: true })}
          {field('App URL', 'appUrl', { type: 'url', full: true })}
          {field('Docs URL', 'docsUrl', { type: 'url', full: true })}
          {field('Runbook URL', 'runbookUrl', { type: 'url', full: true })}
          {field('Repo URL', 'repoUrl', { type: 'url', full: true })}

          <label className="checkbox full">
            <input type="checkbox" checked={form.isActive} onChange={(e) => set('isActive', e.target.checked)} />
            <span>Active</span>
          </label>
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving…' : initial ? 'Save changes' : 'Add'}
          </button>
        </div>
      </form>
    </div>
  );
}
