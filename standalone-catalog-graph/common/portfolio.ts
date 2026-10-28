import type { CatalogModel, Classification } from './shared.js';

export interface QueryWindow {
  start: string;
  end: string;
  previousStart: string;
  hours: number;
  binMinutes: number;
}

export interface Measures {
  rows: number;
  items: number;
  good: number;
  failed: number;
  unknown: number;
  p95: number | null;
  first: string | null;
  last: string | null;
}

export interface TrendPoint extends Measures {
  time: string;
}

export type TargetState = 'met' | 'below' | 'not-configured' | 'invalid' | 'not-observed';

export interface TargetComparison {
  target: number | null;
  success: number | null;
  state: TargetState;
}

export interface AzureResource extends Classification {
  id: string;
  name: string;
  type: string;
  location: string;
}

export interface HostObservation {
  app: string;
  instance: string;
  componentId: string;
  resourceId: string | null;
  observedAt: string;
  state: 'verified' | 'unverified' | 'invalid' | 'unavailable';
  resource: AzureResource | null;
}

export interface AppSummary extends Classification {
  id: string;
  name: string;
  resourceIds: string[];
  registered: boolean;
  catalog: CatalogModel | null;
  current: Measures;
  previous: Measures;
  trend: TrendPoint[];
  lastSeen: string | null;
  target: TargetComparison;
  hosts: HostObservation[];
  findings: string[];
}

export interface GroupSummary {
  kind: 'domain' | 'owner';
  name: string;
  apps: number;
  tier1: number;
  current: Measures;
  previous: Measures;
  trend: TrendPoint[];
}

export interface BackingTarget {
  id: string;
  name: string;
  kind: string;
  target: string;
  protocol: string;
  current: Measures;
}

export type EdgeEvidence = 'matched spans' | 'inferred hostname' | 'observed target';

export interface DependencyConnection {
  id: string;
  source: string;
  destination: string;
  destinationKind: 'service' | 'target';
  target: string;
  protocol: string;
  evidence: EdgeEvidence;
  current: Measures;
}

export interface RegistrationCoverage {
  resource: AzureResource;
  roles: string[];
}

export interface Portfolio {
  window: QueryWindow;
  generatedAt: string;
  warnings: string[];
  apps: AppSummary[];
  groups: GroupSummary[];
  registrations: RegistrationCoverage[];
  targets: BackingTarget[];
  connections: DependencyConnection[];
  workspaceResourceId: string;
}

export interface TransactionExample {
  operationId: string;
  spanId: string;
  app: string;
  name: string;
  time: string;
  duration: number;
  success: boolean | null;
  resultCode: string;
}

export interface TraceSpan extends TransactionExample {
  parentId: string;
  kind: 'request' | 'dependency';
  protocol: string;
  target: string;
  resourceId: string;
}

export interface TraceEvent {
  time: string;
  app: string;
  parentId: string;
  kind: 'log' | 'exception';
  message: string;
  type: string;
  severity: number | null;
}

export interface Transaction {
  operationId: string;
  window: QueryWindow;
  spans: TraceSpan[];
  events: TraceEvent[];
  truncated: boolean;
  warnings: string[];
}

export type GraphLens = 'domains' | 'applications' | 'resources';
export type Relation = 'calls' | 'telemetry' | 'hosting' | 'contains';

export interface ViewNode {
  id: string;
  entityId: string;
  label: string;
  kind: 'domain' | 'service' | 'target' | 'component' | 'host';
  shape: 'round-rectangle' | 'barrel' | 'diamond' | 'round-hexagon';
  domain: string;
  status: string;
  volume: number;
  parent?: string;
  expanded?: boolean;
}

export interface ViewEdge {
  id: string;
  source: string;
  target: string;
  relation: Relation;
  label: string;
  connections: string[];
  calls: number;
  failed: number;
}

export interface GraphProjection {
  nodes: ViewNode[];
  edges: ViewEdge[];
}

export function successPercent(measures: Measures): number | null {
  const known = measures.good + measures.failed;
  return known > 0 ? 100 * measures.good / known : null;
}

export function failureStatus(measures: Measures): string {
  const known = measures.good + measures.failed;
  if (!known) return 'Not observed';
  const rate = 100 * measures.failed / known;
  return rate >= 5 ? 'Error' : rate >= 1 ? 'Warning' : 'Healthy';
}

export function compareTarget(raw: string | undefined, measures: Measures): TargetComparison {
  const success = successPercent(measures);
  if (!raw?.trim()) return { target: null, success, state: 'not-configured' };
  const target = Number(raw);
  if (!Number.isFinite(target) || target < 0 || target > 100) {
    return { target: null, success, state: 'invalid' };
  }
  return { target, success, state: success === null ? 'not-observed' : success >= target ? 'met' : 'below' };
}

export function latencyChange(current: Measures, previous: Measures): {
  absolute: number | null;
  relative: number | null;
} {
  if (current.p95 === null || previous.p95 === null) return { absolute: null, relative: null };
  const absolute = current.p95 - previous.p95;
  return { absolute, relative: previous.p95 > 0 ? 100 * absolute / previous.p95 : null };
}
