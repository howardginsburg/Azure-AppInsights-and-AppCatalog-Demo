import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleGraph, buildEstateKql, clampRange } from '../server/estate.js';
import type { CatalogModel, Classification } from '../common/shared.js';

const RID = '/subscriptions/s/resourcegroups/rg/providers/microsoft.insights/components/appi-orders-api';

const rows = [
  { Id: 'orders-api', Kind: 'service', ResourceId: RID, Calls: 100, Fails: 2, FailPct: 2, P95: 120, Status: 'Warning' },
  { Id: 'billing-api', Kind: 'service', ResourceId: '', Calls: 10, Fails: 0, FailPct: 0, P95: 40, Status: 'Healthy' },
  { Id: 'OrdersDb', Kind: 'database', ResourceId: '', Calls: 50, Fails: 0, FailPct: 0, P95: 9, Status: 'Infra' },
  { SourceId: 'orders-api', TargetId: 'OrdersDb', Calls: 50, EdgeLabel: 'SQL  50' },
];

const tags = new Map<string, Classification>([[RID, { domain: 'Sales', criticality: 'tier1', owner: 'sales-team' }]]);

const catalog: CatalogModel[] = [
  {
    id: '1', workload: 'Orders-API', displayName: 'Orders API', businessOwner: 'VP Sales', description: '',
    appUrl: 'https://orders.example', docsUrl: '', runbookUrl: '', repoUrl: '', slo: '99.9', onCall: 'oncall@example',
    isActive: true,
  },
];

test('splits nodes from edges', () => {
  const g = assembleGraph(rows, tags, catalog);
  assert.equal(g.nodes.length, 3);
  assert.deepEqual(g.edges, [{ source: 'orders-api', target: 'OrdersDb', calls: 50, label: 'SQL  50' }]);
});

test('classifies a service from its resource tags and joins the catalog case-insensitively', () => {
  const n = assembleGraph(rows, tags, catalog).nodes.find((x) => x.id === 'orders-api')!;
  assert.equal(n.name, 'Orders API');
  assert.equal(n.domain, 'Sales');
  assert.equal(n.tagged, true);
  assert.equal(n.cataloged, true);
  assert.equal(n.slo, '99.9');
  assert.equal(n.appUrl, 'https://orders.example');
});

test('marks a service without tags or a catalog entry', () => {
  const n = assembleGraph(rows, tags, catalog).nodes.find((x) => x.id === 'billing-api')!;
  assert.equal(n.tagged, false);
  assert.equal(n.cataloged, false);
  assert.equal(n.name, 'billing-api');
  assert.equal(n.domain, '');
});

test('never tags or catalogs infrastructure nodes', () => {
  const n = assembleGraph(rows, tags, catalog).nodes.find((x) => x.id === 'OrdersDb')!;
  assert.equal(n.tagged, false);
  assert.equal(n.cataloged, false);
  assert.equal(n.resourceId, null);
});

test('binds the time range and appends the final expression', () => {
  const kql = buildEstateKql(6);
  assert.ok(kql.includes('> ago(6h)'));
  assert.ok(!kql.includes('{TimeRange}'));
  assert.ok(kql.trimEnd().endsWith('nodes\n| union links'));
});

test('clamps the time range', () => {
  assert.equal(clampRange(undefined), 24);
  assert.equal(clampRange('abc'), 24);
  assert.equal(clampRange(0), 24);
  assert.equal(clampRange(5000), 720);
  assert.equal(clampRange('12'), 12);
});
