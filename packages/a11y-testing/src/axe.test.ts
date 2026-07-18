import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';

const packageRoot = join(import.meta.dir, '..');
const subprocessTestTimeoutMilliseconds = 60_000;

describe('Axe helper consumer lint compatibility', () => {
  it(
    'passes when the consumer disables noSecrets',
    () => {
      const result = spawnSync(
        process.execPath,
        [
          'x',
          '--no-install',
          'biome',
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
