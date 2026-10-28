/**
 * Reads app classification from Azure Resource Graph: the domain, criticality, and owner
 * tags on every Application Insights resource linked to the workspace.
 *
 * The identity needs read access to those resources. Log Analytics Reader on the resource
 * group grants it.
 */
import { credential } from './credential.js';
import type { Classification } from '../common/shared.js';

const API_VERSION = '2024-04-01';
const DEFAULT_HOST = 'https://management.azure.com';

interface ResourceGraphResponse {
  data: Array<{ id: string; domain: string | null; criticality: string | null; owner: string | null }>;
  $skipToken?: string;
}

/** Map of lowercase Application Insights resource ID to its classification tags. */
export async function getAppClassifications(
  workspaceResourceId: string,
  host = DEFAULT_HOST,
): Promise<Map<string, Classification>> {
  if (!/^\/subscriptions\/[^'"\\]+$/i.test(workspaceResourceId)) {
    throw new Error('LA_WORKSPACE_RESOURCE_ID is not a valid resource ID.');
  }
  const base = host.replace(/\/+$/, '');
  const token = await credential.getToken(`${base}/.default`);
  if (!token?.token) throw new Error('Failed to acquire an Azure Resource Manager token.');

  const query = `resources
| where type =~ 'microsoft.insights/components'
| where tolower(tostring(properties.WorkspaceResourceId)) == '${workspaceResourceId.toLowerCase()}'
| project id = tolower(id), domain = tostring(tags.domain),
          criticality = tostring(tags.criticality), owner = tostring(tags.owner)`;

  const result = new Map<string, Classification>();
  let skipToken: string | undefined;
  do {
    const res = await fetch(`${base}/providers/Microsoft.ResourceGraph/resources?api-version=${API_VERSION}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        options: { resultFormat: 'objectArray', $top: 1000, ...(skipToken ? { $skipToken: skipToken } : {}) },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resource Graph query failed: HTTP ${res.status} ${res.statusText} — ${detail.slice(0, 300)}`);
    }
    const body = (await res.json()) as ResourceGraphResponse;
    for (const r of body.data ?? []) {
      result.set(r.id, { domain: r.domain ?? '', criticality: r.criticality ?? '', owner: r.owner ?? '' });
    }
    skipToken = body.$skipToken;
  } while (skipToken);
  return result;
}
