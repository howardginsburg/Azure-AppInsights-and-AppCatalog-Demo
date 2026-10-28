import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSupportedNode } from '../server/runtime.js';

for (const version of ['24.22.1', '24.22.2', '24.23.0', '24.100.0']) {
  test(`accepts patched Node.js ${version}`, () => {
    assert.doesNotThrow(() => assertSupportedNode(version));
  });
}

for (const version of [
  '20.20.2', '22.23.4', '24.21.9', '24.22.0',
  '24.22.1-rc.1', '25.0.0', '26.12.1', 'not-a-version',
]) {
  test(`refuses unsupported Node.js ${version}`, () => {
    assert.throws(() => assertSupportedNode(version), /Refusing to start/);
  });
}

test('accepts the actual test-process runtime', () => {
  assert.doesNotThrow(() => assertSupportedNode());
});
