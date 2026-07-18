import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';

const packageRoot = join(import.meta.dir, '..');
// The installed launcher resolves the native binary locally, so the invocation
// never touches package resolution or the network.
const biomeLauncherPath = globalThis.Bun.resolveSync(
  '@biomejs/biome/bin/biome',
  import.meta.dir,
);
// Last-resort guard only; the direct launcher invocation is the stabilization mechanism.
const subprocessTestTimeoutMilliseconds = 30_000;

describe('Axe helper consumer lint compatibility', () => {
  it(
    'passes when the consumer disables noSecrets',
    () => {
      const result = spawnSync(
        process.execPath,
        [
          biomeLauncherPath,
          'check',
          '--error-on-warnings',
          '--config-path',
          join(packageRoot, 'axe-consumer-biome.jsonc'),
          join(import.meta.dir, 'axe.ts'),
        ],
        {
          cwd: packageRoot,
          encoding: 'utf8',
        },
      );

      expect({
        exitCode: result.status,
        stderr: result.stderr,
      }).toEqual({
        exitCode: 0,
        stderr: '',
      });
    },
    subprocessTestTimeoutMilliseconds,
  );
});
