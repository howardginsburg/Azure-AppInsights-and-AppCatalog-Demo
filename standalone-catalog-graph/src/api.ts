import type { CatalogInput, CatalogModel, EstateGraph } from '../common/shared';
import type { Portfolio, QueryWindow, Transaction, TransactionExample } from '../common/portfolio';

/** Thin fetch wrapper around the Express API served from the same origin. */

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string };
      detail = body?.error ?? '';
    } catch {
      detail = await res.text().catch(() => '');
    }
    throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

export async function fetchEstate(rangeHours: number): Promise<EstateGraph> {
  return json<EstateGraph>(await fetch(`/api/estate?rangeHours=${encodeURIComponent(rangeHours)}`));
}

export async function fetchCatalog(): Promise<CatalogModel[]> {
  return json<CatalogModel[]>(await fetch('/api/catalog'));
}

export async function fetchPortfolio(hours: number): Promise<Portfolio> {
  return json<Portfolio>(await fetch(`/api/portfolio?rangeHours=${hours}`));
}

const windowParameters = (window: QueryWindow) =>
  `rangeHours=${window.hours}&end=${encodeURIComponent(window.end)}`;

export async function fetchExamples(window: QueryWindow, app: string, mode: 'failed' | 'slow'):
Promise<{ items: TransactionExample[]; truncated: boolean }> {
  return json(await fetch(`/api/transactions?${windowParameters(window)}&app=${encodeURIComponent(app)}&mode=${mode}`));
}

export async function fetchTransaction(window: QueryWindow, operationId: string): Promise<Transaction> {
  return json(await fetch(`/api/transactions/${encodeURIComponent(operationId)}?${windowParameters(window)}`));
}

export async function createCatalog(input: CatalogInput): Promise<CatalogModel> {
  return json<CatalogModel>(
    await fetch('/api/catalog', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

export async function updateCatalog(id: string, input: CatalogInput): Promise<CatalogModel> {
  return json<CatalogModel>(
    await fetch(`/api/catalog/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

export async function deleteCatalog(id: string): Promise<void> {
  const res = await fetch(`/api/catalog/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    await json(res); // throws with the server's error detail
  }
}
