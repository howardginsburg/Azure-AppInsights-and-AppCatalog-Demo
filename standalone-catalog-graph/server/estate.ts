/**
 * Builds the estate graph: topology and health from Log Analytics, classification from the
 * Azure tags on each app's Application Insights resource, and business context from the
 * catalog. The three are joined on the app name (AppRoleName) and the resource ID.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { credential } from './credential.js';
import { queryLogAnalytics, type QueryRow } from './logAnalytics.js';
import { getAppClassifications } from './resourceGraph.js';
import { listCatalog } from './catalogDb.js';
import type {
  CatalogModel,
  Classification,
  EstateGraph,
  GraphEdge,
  GraphNode,
} from '../common/shared.js';

const DEFAULT_RANGE_HOURS = 24;
const MAX_RANGE_HOURS = 720;

const here = path.dirname(fileURLToPath(import.meta.url));
// estate.kql sits next to this file in the source tree. The compiled file runs from
// dist-server/server/, two levels below the project root.
const KQL_PATH = [path.join(here, 'estate.kql'), path.resolve(here, '..', '..', 'server', 'estate.kql')].find(
  (p) => existsSync(p),
);
let estateKql: string | undefined;

export function clampRange(hours: unknown): number {
  const n = Math.floor(Number(hours));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_RANGE_HOURS;
  return Math.min(n, MAX_RANGE_HOURS);
}

/** The shared estate query, bound to a time range, returning nodes and edges in one result. */
export function buildEstateKql(rangeHours: number): string {
  if (!estateKql) {
    if (!KQL_PATH) throw new Error('server/estate.kql was not found.');
    estateKql = readFileSync(KQL_PATH, 'utf8');
  }
  return `${estateKql.replaceAll('{TimeRange}', `> ago(${clampRange(rangeHours)}h)`)}\nnodes\n| union links`;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/** Joins query rows with tags and catalog rows. Pure, so it can be unit tested. */
export function assembleGraph(
  rows: QueryRow[],
  classifications: Map<string, Classification>,
  catalog: CatalogModel[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const byWorkload = new Map(catalog.map((c) => [c.workload.toLowerCase(), c]));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const r of rows) {
    if (str(r.SourceId)) {
      edges.push({ source: str(r.SourceId), target: str(r.TargetId), calls: num(r.Calls), label: str(r.EdgeLabel) });
      continue;
    }
    const id = str(r.Id);
    if (!id) continue;
    const kind = str(r.Kind);
    const isService = kind === 'service';
    const resourceId = str(r.ResourceId).toLowerCase() || null;
    const tags = isService && resourceId ? classifications.get(resourceId) : undefined;
    const cat = isService ? byWorkload.get(id.toLowerCase()) : undefined;

    nodes.push({
      id,
      kind,
      name: cat?.displayName || id,
      domain: tags?.domain ?? '',
      criticality: tags?.criticality ?? '',
      owner: tags?.owner ?? '',
      resourceId,
      tagged: Boolean(tags?.domain && tags.criticality && tags.owner),
      cataloged: Boolean(cat),
      businessOwner: cat?.businessOwner || null,
      slo: cat?.slo || null,
      onCall: cat?.onCall || null,
      appUrl: cat?.appUrl || null,
      docsUrl: cat?.docsUrl || null,
      runbookUrl: cat?.runbookUrl || null,
      repoUrl: cat?.repoUrl || null,
      calls: num(r.Calls),
      fails: num(r.Fails),
      failPct: num(r.FailPct),
      p95: num(r.P95),
      status: str(r.Status),
    });
  }
  return { nodes, edges };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function getEstateGraph(rangeHoursInput?: unknown): Promise<EstateGraph> {
  const rangeHours = clampRange(rangeHoursInput);
  const workspaceId = process.env.LA_WORKSPACE_ID;
  if (!workspaceId) throw new Error('LA_WORKSPACE_ID must be set.');
  const workspaceResourceId = process.env.LA_WORKSPACE_RESOURCE_ID;
  const laHost = (process.env.LA_API_HOST ?? '').trim() || 'https://api.loganalytics.io';
  const armHost = (process.env.ARM_HOST ?? '').trim() || undefined;

  const token = await credential.getToken(`${laHost.replace(/\/+$/, '')}/.default`);
  if (!token?.token) throw new Error('Failed to acquire a Log Analytics token.');

  const warnings: string[] = [];
  let tagsPromise: Promise<Map<string, Classification>>;
  if (workspaceResourceId) {
    tagsPromise = getAppClassifications(workspaceResourceId, armHost).catch((err) => {
      warnings.push(`Application Insights tags are unavailable: ${message(err)}`);
      return new Map<string, Classification>();
    });
  } else {
    warnings.push('LA_WORKSPACE_RESOURCE_ID is not set, so Application Insights tags are unavailable.');
    tagsPromise = Promise.resolve(new Map<string, Classification>());
  }
  const catalogPromise = listCatalog().catch((err) => {
    warnings.push(`The catalog is unavailable: ${message(err)}`);
    return [] as CatalogModel[];
  });

  const [rows, classifications, catalog] = await Promise.all([
    queryLogAnalytics({ token: token.token, workspaceId, host: laHost, query: buildEstateKql(rangeHours) }),
    tagsPromise,
    catalogPromise,
  ]);

  return {
    ...assembleGraph(rows, classifications, catalog),
    generatedAt: new Date().toISOString(),
    rangeHours,
    warnings,
  };
}
