/**
 * Types shared by the Express server and the React frontend.
 */

/** The classification tags on an app's Application Insights resource. */
export interface Classification {
  domain: string;
  criticality: string;
  owner: string;
}

export interface GraphNode {
  id: string;
  /** service | database | datastore | queue | external */
  kind: string;
  /** Catalog display name when cataloged, otherwise the id. */
  name: string;
  /** Tag values. Empty when a tag is missing or the node is not a service. */
  domain: string;
  criticality: string;
  owner: string;
  /** The Application Insights resource that received this service's telemetry. */
  resourceId: string | null;
  /** True when that resource carries all three classification tags. */
  tagged: boolean;
  /** True when the catalog has an entry for this id. */
  cataloged: boolean;
  businessOwner: string | null;
  slo: string | null;
  onCall: string | null;
  appUrl: string | null;
  docsUrl: string | null;
  runbookUrl: string | null;
  repoUrl: string | null;
  calls: number;
  fails: number;
  failPct: number;
  p95: number;
  status: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  calls: number;
  label: string;
}

export interface EstateGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  generatedAt: string;
  rangeHours: number;
  /** Non-fatal problems, such as tags or the catalog being unavailable. */
  warnings: string[];
}

/** A catalog row: business context for one app, keyed by its service name (`workload`). */
export interface CatalogModel {
  id: string;
  workload: string;
  displayName: string;
  businessOwner: string;
  description: string;
  appUrl: string;
  docsUrl: string;
  runbookUrl: string;
  repoUrl: string;
  slo: string;
  onCall: string;
  isActive: boolean;
}

/** The writable fields of a catalog row. `id` is assigned by the server. */
export type CatalogInput = Omit<CatalogModel, 'id'>;

export interface ImportResult {
  inserted: number;
  skipped: number;
  total: number;
}
