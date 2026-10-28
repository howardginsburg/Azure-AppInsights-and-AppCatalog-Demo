/**
 * Reads app classification from Azure Resource Graph: the domain, criticality, and owner
 * tags on every Application Insights resource linked to the workspace.
 *
 * The identity needs read access to those resources. Log Analytics Reader on the resource
 * group grants it.
 */
import { credential } from './credential.js';
import { azureQuery } from './azureQuery.js';
import type { Classification } from '../common/shared.js';
import type { AzureResource } from '../common/portfolio.js';

const API_VERSION = '2024-04-01';
const DEFAULT_HOST = 'https://management.azure.com';

interface ResourceGraphResponse {
  data: AzureResource[];
  $skipToken?: string;
}

/** Map of lowercase Application Insights resource ID to its classification tags. */
export async function getAppClassifications(
  workspaceResourceId: string,
  host = DEFAULT_HOST,
): Promise<Map<string, Classification>> {
  const resources = await getRegistrations(workspaceResourceId, host);
  return new Map(resources.map((r) => [r.id, { domain: r.domain, criticality: r.criticality, owner: r.owner }]));
}

export async function getRegistrations(
  workspaceResourceId: string,
  host = DEFAULT_HOST,
): Promise<AzureResource[]> {
  if (!/^\/subscriptions\/[^'"\\]+$/i.test(workspaceResourceId)) {
    throw new Error('LA_WORKSPACE_RESOURCE_ID is not a valid resource ID.');
  }
  const query = `resources
| where type =~ 'microsoft.insights/components'
| where tolower(tostring(properties.WorkspaceResourceId)) == '${workspaceResourceId.toLowerCase()}'
| project id = tolower(id), name, type, location, domain = tostring(tags.domain),
          criticality = tostring(tags.criticality), owner = tostring(tags.owner)`;
  return queryResources(query, [workspaceResourceId.split('/')[2]], host);
}

export function isResourceId(value: string): boolean {
  return /^\/subscriptions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/resourcegroups\/[^/'"\\]+\/providers\/[a-z0-9.]+\/[^'"\\]+$/i.test(value);
}

export async function getReportedResources(ids: string[], host = DEFAULT_HOST): Promise<AzureResource[]> {
  const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
  if (!unique.length) return [];
  if (unique.length > 2000) throw new Error('At most 2,000 reported hosting resources can be resolved.');
  if (unique.some((id) => !isResourceId(id))) throw new Error('Reported hosting identity contains an invalid ARM resource ID.');
  const query = `resources | where tolower(id) in (${unique.map((id) => JSON.stringify(id)).join(',')})
| project id = tolower(id), name, type, location, domain = tostring(tags.domain),
          criticality = tostring(tags.criticality), owner = tostring(tags.owner)`;
  return queryResources(query, [...new Set(unique.map((id) => id.split('/')[2]))], host);
}

async function queryResources(query: string, subscriptions: string[], host: string): Promise<AzureResource[]> {
  const base = host.replace(/\/+$/, '');
  const token = await credential.getToken(`${base}/.default`);
  if (!token?.token) throw new Error('Failed to acquire an Azure Resource Manager token.');
  const result: AzureResource[] = [];
  const seenTokens = new Set<string>();
  let skipToken: string | undefined;
  do {
    const res = await azureQuery(`${base}/providers/Microsoft.ResourceGraph/resources?api-version=${API_VERSION}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        subscriptions,
        options: { resultFormat: 'objectArray', $top: 1000, ...(skipToken ? { $skipToken: skipToken } : {}) },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resource Graph query failed: HTTP ${res.status} ${res.statusText} — ${detail.slice(0, 300)}`);
    }
    const body = (await res.json()) as ResourceGraphResponse;
    if (!Array.isArray(body.data)) throw new Error('Resource Graph returned an invalid resource list.');
    for (const r of body.data) {
      result.push({
        id: r.id.toLowerCase(), name: r.name, type: r.type, location: r.location,
        domain: r.domain ?? '', criticality: r.criticality ?? '', owner: r.owner ?? '',
      });
    }
    skipToken = body.$skipToken;
    if (skipToken && seenTokens.has(skipToken)) throw new Error('Resource Graph repeated a pagination token.');
    if (skipToken) seenTokens.add(skipToken);
  } while (skipToken);
  return result;
}
