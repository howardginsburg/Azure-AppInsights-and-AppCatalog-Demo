import assert from 'node:assert/strict';
import test from 'node:test';
import { compareTarget, latencyChange, successPercent } from '../common/portfolio.js';
import type { AzureResource, Measures } from '../common/portfolio.js';
import type { CatalogModel } from '../common/shared.js';
import { assembleGroups, assemblePortfolio, assembleTransaction, parseWindow } from '../server/portfolio.js';
import { makeWindow, portfolioQuery, topologyQuery } from '../server/portfolioQueries.js';
import { isResourceId } from '../server/resourceGraph.js';
import { exposure, overlayTransaction, projectGraph, traceConnections } from '../src/graphModel.js';

const window = makeWindow(24, new Date('2026-10-28T00:00:00Z'));
const rid = '/subscriptions/12345678-1234-1234-1234-123456789012/resourcegroups/test/providers/microsoft.insights/components/appi-api';
const resource: AzureResource = {
  id: rid, name: 'appi-api', type: 'microsoft.insights/components', location: 'centralus',
  domain: 'Sales', owner: 'sales-team', criticality: 'tier1',
};
const catalog: CatalogModel = {
  id: '1', workload: 'api', displayName: 'Orders API', businessOwner: 'VP Sales', description: 'Handles orders',
  appUrl: '', docsUrl: '', runbookUrl: 'https://example.com/runbook', repoUrl: '',
  slo: '99.5', onCall: 'sales-oncall', isActive: true,
};
const current = {
  Section: 'app', App: 'api', Period: 'current', Rows: 510, Calls: 510, Good: 507,
  Fails: 3, Unknown: 0, P95: 90, ResourceIds: JSON.stringify([rid]),
  FirstSeen: '2026-10-27T01:00:00Z', LastSeen: '2026-10-27T23:00:00Z',
};
const base = () => assemblePortfolio([current], [], [resource], [catalog], window);

test('success target is compared before display rounding and is separate from failure-rate health', () => {
  const app = base().apps[0];
  assert.equal(app.target.state, 'below');
  assert.ok(app.target.success! < 99.5);
  assert.equal(compareTarget('99.5', { ...app.current, good: 995, failed: 5 }).state, 'met');
  assert.equal(compareTarget('100', { ...app.current, good: 999999, failed: 1 }).state, 'below');
});

test('unknown and absent observations do not produce invented success', () => {
  const metrics = base().apps[0].current;
  assert.equal(successPercent({ ...metrics, good: 0, failed: 0, unknown: 10 }), null);
  assert.equal(compareTarget('99.9', { ...metrics, good: 0, failed: 0 }).state, 'not-observed');
  assert.equal(compareTarget('', metrics).state, 'not-configured');
  for (const value of ['not-a-percentage', '-1', '101', 'Infinity']) {
    assert.equal(compareTarget(value, metrics).state, 'invalid');
  }
});

test('missing or zero latency baseline has no infinite or invented relative change', () => {
  const current = base().apps[0].current;
  assert.deepEqual(latencyChange(current, { ...current, p95: null }), { absolute: null, relative: null });
  assert.deepEqual(latencyChange(current, { ...current, p95: 0 }), { absolute: 90, relative: null });
});

test('query windows are adjacent, UTC anchored, validated and non-overlapping', () => {
  assert.equal(window.start, '2026-10-27T00:00:00.000Z');
  assert.equal(window.previousStart, '2026-10-26T00:00:00.000Z');
  for (const h of ['0', '-1', '721', '1.5', 'oops', ['24']]) assert.throws(() => parseWindow(h, undefined));
  assert.throws(() => parseWindow('24', 'not-a-date'));
  assert.throws(() => parseWindow('24', new Date(Date.now() + 3_600_000).toISOString()));
  assert.match(portfolioQuery(window), /percentilew/);
  assert.match(topologyQuery(window), /operation/);
  assert.doesNotMatch(topologyQuery(window), /\{TimeRange\}/);
});

test('resource arrays returned as serialized dynamics still classify and retain the correct identity', () => {
  const app = base().apps[0];
  assert.deepEqual(app.resourceIds, [rid]);
  assert.equal(app.domain, 'Sales');
  assert.equal(app.name, 'Orders API');
  assert.equal(app.catalog?.description, 'Handles orders');
  assert.equal(base().registrations[0].roles[0], 'api');
});

test('catalog-only and registered-but-unobserved resources do not invent service identities', () => {
  const data = assemblePortfolio([], [], [resource], [catalog], window);
  assert.equal(data.apps[0].id, 'api');
  assert.equal(data.apps[0].registered, false);
  assert.equal(data.apps[0].current.p95, null);
  assert.deepEqual(data.registrations[0].roles, []);
  const graph = projectGraph(data, 'resources', new Set());
  assert.equal(graph.nodes.filter((n) => n.kind === 'component').length, 1);
  assert.equal(graph.edges.length, 0);
});

test('ambiguous resource tags are explicit and not arbitrarily selected', () => {
  const other = { ...resource, id: rid + '-other', domain: 'Payments' };
  const data = assemblePortfolio([{ ...current, ResourceIds: [rid, other.id] }], [], [resource, other], [catalog], window);
  assert.equal(data.apps[0].domain, '');
  assert.ok(data.apps[0].findings.includes('Conflicting domain across telemetry resources'));
});

test('missing hosting metadata never turns the telemetry destination into a compute host', () => {
  const data = assemblePortfolio([current, {
    Section: 'host', App: 'api', Instance: 'api-01', Component: rid,
    HostId: '', LastSeen: window.start,
  }], [], [resource], [catalog], window);
  assert.equal(data.apps[0].hosts[0].state, 'unavailable');
  const graph = projectGraph(data, 'resources', new Set());
  assert.equal(graph.nodes.filter((n) => n.kind === 'host').length, 0);
  assert.equal(graph.edges.filter((e) => e.relation === 'telemetry').length, 1);
  assert.equal(graph.edges.filter((e) => e.relation === 'hosting').length, 0);
});

test('reported host identities support multiple instances without discarding provenance', () => {
  const rows = ['one', 'two'].map((instance) => ({
    Section: 'host', App: 'api', Instance: instance, Component: rid,
    HostId: rid.replace('microsoft.insights/components/appi-api', `microsoft.web/sites/${instance}`),
    LastSeen: window.start,
  }));
  const data = assemblePortfolio([current, ...rows], [], [resource], [catalog], window);
  assert.equal(data.apps[0].hosts.length, 2);
  assert.ok(data.apps[0].hosts.every((h) => h.state === 'unverified'));
  assert.equal(projectGraph(data, 'resources', new Set()).nodes.filter((n) => n.kind === 'host').length, 2);
  assert.equal(isResourceId(rows[0].HostId), true);
  assert.equal(isResourceId('https://example.com'), false);
});

test('domain projection preserves calls and expands without duplicating applications', () => {
  const data = base();
  const second = { ...data.apps[0], id: 'worker', name: 'Worker', domain: 'Payments', resourceIds: [] };
  data.apps.push(second);
  data.groups = [
    { kind: 'domain', name: 'Sales', apps: 1, tier1: 1, current: data.apps[0].current, previous: data.apps[0].previous, trend: [] },
    { kind: 'domain', name: 'Payments', apps: 1, tier1: 1, current: second.current, previous: second.previous, trend: [] },
  ];
  data.connections = [{ id: 'edge', source: 'api', destination: 'worker', destinationKind: 'service',
    target: 'worker.internal', protocol: 'HTTP', evidence: 'matched spans', current: data.apps[0].current }];
  const collapsed = projectGraph(data, 'domains', new Set());
  assert.equal(collapsed.nodes.length, 2);
  assert.equal(collapsed.edges[0].source, 'domain:Sales');
  const expanded = projectGraph(data, 'domains', new Set(['Sales']));
  assert.equal(expanded.nodes.filter((n) => n.kind === 'service').length, 1);
  assert.equal(expanded.edges[0].source, 'app:api');
  assert.equal(expanded.edges[0].target, 'domain:Payments');
});

test('impact traversal is cycle-safe, direction-aware and only follows workload calls', () => {
  const data = base();
  const metrics = data.apps[0].current;
  data.connections = [['a', 'api'], ['api', 'b'], ['b', 'api'], ['z', 'a']].map(([source, destination], i) => ({
    id: `e${i}`, source, destination, destinationKind: 'service', target: destination,
    protocol: 'HTTP', evidence: 'matched spans', current: metrics,
  }));
  assert.deepEqual([...exposure(data, 'api', 'upstream')].sort(), ['a', 'api', 'b', 'z']);
  assert.deepEqual([...exposure(data, 'api', 'downstream')].sort(), ['api', 'b']);
});

test('group percentiles come from grouped query rows rather than app percentile averages', () => {
  const data = base();
  const groups = assembleGroups([
    { Section: 'group', GroupKind: 'domain', Group: 'Sales', Period: 'current', Rows: 100, Calls: 100, Good: 90, Fails: 10, P95: 500 },
  ], data.apps);
  const sales = groups.find((g) => g.kind === 'domain')!;
  assert.equal(sales.current.p95, 500);
  assert.equal(sales.current.good, 90);
});

test('transaction preserves repeated visits, root success and later failure without invented parents', () => {
  const rows = [
    { Section: 'span', Kind: 'request', App: 'web', Id: 'root', ParentId: '01234567890123456789012345678901', Name: 'Checkout', TimeGenerated: window.start, DurationMs: 100, Success: true },
    { Section: 'span', Kind: 'dependency', App: 'api', Id: 'dep', ParentId: 'missing', Name: 'Commit', Target: 'inventory', DependencyType: 'HTTP', TimeGenerated: window.start, DurationMs: 50, Success: false },
    { Section: 'span', Kind: 'request', App: 'inventory', Id: 'receive', ParentId: 'dep', Name: 'Commit', TimeGenerated: window.start, DurationMs: 45, Success: false },
    { Section: 'event', Kind: 'exception', App: 'inventory', ParentId: 'receive', TimeGenerated: window.start, Message: 'Deadlock', ExceptionType: 'SqlException' },
  ];
  const trace = assembleTransaction(rows, '01234567890123456789012345678901', window);
  assert.equal(trace.spans.length, 3);
  assert.equal(trace.events[0].parentId, 'receive');
  assert.equal(trace.spans[0].success, true);
  assert.match(trace.warnings[0], /parents outside/);
  const data = base();
  data.connections = [{ id: 'commit', source: 'api', destination: 'inventory', destinationKind: 'service',
    target: 'inventory', protocol: 'HTTP', evidence: 'matched spans', current: data.apps[0].current }];
  assert.deepEqual([...traceConnections(data, trace)], ['commit']);
  const graph = projectGraph(data, 'applications', new Set());
  data.apps.push({ ...data.apps[0], id: 'inventory', name: 'Inventory' });
  const updated = overlayTransaction(projectGraph(data, 'applications', new Set()), data, trace);
  assert.equal(updated.nodes.find((n) => n.id === 'app:inventory')?.status, 'Error');
  assert.equal(updated.edges[0].label, 'This trace: 1 dependency spans · 1 failed');
  assert.equal(graph.nodes[0].status, 'Healthy');
});

test('resource states retain malformed host IDs as invalid rather than manufacturing a host', () => {
  const data = assemblePortfolio([current, {
    Section: 'host', App: 'api', Instance: 'api-01', Component: rid,
    HostId: 'not-an-arm-id', LastSeen: window.start,
  }], [], [resource], [catalog], window);
  assert.equal(data.apps[0].hosts[0].state, 'invalid');
  assert.equal(projectGraph(data, 'resources', new Set()).nodes.filter((n) => n.kind === 'host').length, 0);
});

test('full backing-target identity keeps databases and queue entities distinct', () => {
  const data = base();
  const m = data.apps[0].current;
  data.targets = [
    { id: 'sql:server-one/db', name: 'db', kind: 'database', target: 'server-one | db', protocol: 'SQL', current: m },
    { id: 'sql:server-two/db', name: 'db', kind: 'database', target: 'server-two | db', protocol: 'SQL', current: m },
    { id: 'sb:host/one', name: 'queue', kind: 'queue', target: 'host/one', protocol: 'servicebus', current: m },
    { id: 'sb:host/two', name: 'queue', kind: 'queue', target: 'host/two', protocol: 'servicebus', current: m },
  ];
  assert.equal(new Set(projectGraph(data, 'applications', new Set()).nodes.filter((n) => n.kind === 'target').map((n) => n.id)).size, 4);
});

test('result budgets fail loudly instead of silently publishing incomplete portfolio coverage', () => {
  assert.throws(() => assemblePortfolio(Array.from({ length: 12001 }, () => ({})), [], [], [], window), /result budget/);
});
