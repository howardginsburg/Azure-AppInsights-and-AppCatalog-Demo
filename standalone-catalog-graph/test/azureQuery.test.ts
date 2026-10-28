import assert from 'node:assert/strict';
import test from 'node:test';
import { azureQuery } from '../server/azureQuery.js';
import { queryLogAnalytics } from '../server/logAnalytics.js';

test('transient read-query network errors are retried but not hidden', async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++attempts < 2) throw new TypeError('fetch failed');
    return new Response('{"ok":true}');
  });
  const response = await azureQuery('https://example.test/query', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
});

test('permission failures are not retried as transient successes', async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => { attempts++; return new Response('Forbidden', { status: 403 }); });
  const response = await azureQuery('https://example.test/query', { method: 'POST' });
  assert.equal(response.status, 403);
  assert.equal(attempts, 1);
});

test('Log Analytics partial responses do not silently become healthy incomplete data', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    tables: [{ name: 'PrimaryResult', columns: [], rows: [] }],
    error: { code: 'PartialError', message: 'A source could not be queried' },
  })));
  await assert.rejects(() => queryLogAnalytics({
    workspaceId: 'workspace', token: 'test-token', query: 'print x=1',
  }), /partial results/);
});
