import assert from 'node:assert/strict';
import test from 'node:test';
import { isGuid, parseCatalogInput } from '../server/catalogInput.js';

test('accepts a minimal row and trims values', () => {
  const r = parseCatalogInput({ workload: ' orders-api ', displayName: 'Orders API' });
  assert.ok(!('error' in r));
  assert.equal(r.workload, 'orders-api');
  assert.equal(r.isActive, true);
  assert.equal(r.slo, '');
});

test('requires workload and displayName', () => {
  assert.deepEqual(parseCatalogInput({ displayName: 'x' }), { error: 'Field "workload" is required.' });
  assert.deepEqual(parseCatalogInput({ workload: 'x' }), { error: 'Field "displayName" is required.' });
});

test('rejects non-objects', () => {
  assert.ok('error' in parseCatalogInput(null));
  assert.ok('error' in parseCatalogInput([]));
  assert.ok('error' in parseCatalogInput('x'));
});

test('rejects links that are not http(s)', () => {
  const r = parseCatalogInput({ workload: 'a', displayName: 'A', docsUrl: 'javascript:alert(1)' });
  assert.deepEqual(r, { error: 'Field "docsUrl" must start with http:// or https://.' });
});

test('rejects values longer than the column', () => {
  const r = parseCatalogInput({ workload: 'a'.repeat(101), displayName: 'A' });
  assert.deepEqual(r, { error: 'Field "workload" exceeds 100 characters.' });
});

test('recognizes GUIDs', () => {
  assert.ok(isGuid('3f2504e0-4f89-11d3-9a0c-0305e82c3301'));
  assert.ok(!isGuid('not-a-guid'));
});
