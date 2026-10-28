/**
 * Log Analytics query client.
 *
 * AUTH: a bearer token for `https://api.loganalytics.io/.default`, acquired by the caller
 * from the App Service **system-assigned managed identity** (DefaultAzureCredential). The
 * identity needs **Log Analytics Reader** on the workspace.
 *
 * Endpoint (default): `https://api.loganalytics.io/v1/workspaces/<guid>/query`.
 */

export type LogAnalyticsColumn = { name: string; type?: string };
export type LogAnalyticsTable = {
  name: string;
  columns: LogAnalyticsColumn[];
  rows: unknown[][];
};
export type LogAnalyticsResponse = { tables: LogAnalyticsTable[] };

/** Row objects keyed by column name — easier to consume than positional arrays. */
export type QueryRow = Record<string, unknown>;

const DEFAULT_HOST = 'https://api.loganalytics.io';

export interface QueryLogAnalyticsOptions {
  token: string;
  workspaceId: string;
  query: string;
  /** Override host (defaults to https://api.loganalytics.io). */
  host?: string;
}

export async function queryLogAnalytics(
  opts: QueryLogAnalyticsOptions,
): Promise<QueryRow[]> {
  const host = (opts.host ?? DEFAULT_HOST).replace(/\/+$/, '');
  const url = `${host}/v1/workspaces/${encodeURIComponent(opts.workspaceId)}/query`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: opts.query }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `Log Analytics query failed: HTTP ${res.status} ${res.statusText} — ${detail.slice(0, 500)}`,
    );
  }

  const body = (await res.json()) as LogAnalyticsResponse;
  const table =
    body.tables?.find((t) => t.name === 'PrimaryResult') ?? body.tables?.[0];
  if (!table) return [];

  const cols = table.columns.map((c) => c.name);
  return table.rows.map((row) => {
    const obj: QueryRow = {};
    cols.forEach((name, i) => {
      obj[name] = row[i];
    });
    return obj;
  });
}
