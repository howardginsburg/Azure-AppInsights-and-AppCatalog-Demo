import { satisfies } from 'semver';
import packageJson from '../package.json' with { type: 'json' };

export function assertSupportedNode(version = process.versions.node): void {
  if (!satisfies(version, packageJson.engines.node)) {
    throw new Error(
      `Node.js ${version} does not meet ${packageJson.engines.node}. ` +
      'Refusing to start: install a patched Node.js runtime before serving requests.',
    );
  }
}
