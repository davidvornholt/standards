import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { DEV_ENV_GENERATED_HEADER } from './dev-env-dotenv';
import { initializeDevEnvGit } from './dev-env-test-support';

const PROBE_TIMEOUT_MS = 1000;
const reconciliationUrl = new URL(
  './dev-env-reconciliation.ts',
  import.meta.url,
).href;
const transactionUrl = new URL('./dev-env-transaction.ts', import.meta.url)
  .href;

const fixture = (): { readonly consumer: string; readonly env: string } => {
  const consumer = mkdtempSync(join(tmpdir(), 'dev-env-removal-fifo-'));
  initializeDevEnvGit(consumer);
  const workspace = join(consumer, 'packages/db');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'package.json'), '{}\n');
  const env = join(workspace, '.env.local');
  writeFileSync(env, `${DEV_ENV_GENERATED_HEADER}\nOLD_DB=1\n`);
  return { consumer, env };
};

const makeFifo = (path: string): void => {
  rmSync(path, { force: true });
  execFileSync('mkfifo', [path]);
};

const runProbe = (source: string): unknown => {
  const output = execFileSync(process.execPath, ['--eval', source], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
  });
  return JSON.parse(output.trim());
};

const artifacts = (consumer: string): ReadonlyArray<string> =>
  readdirSync(join(consumer, 'packages/db')).filter((name) =>
    name.includes('.standards-'),
  );

describe('dev env removal FIFO handling', () => {
  it('does not block while planning a pre-existing FIFO', () => {
    const { consumer, env } = fixture();
    try {
      makeFifo(env);
      const result = runProbe(`
        import { planDevEnvRemovals } from ${JSON.stringify(reconciliationUrl)};
        const plan = planDevEnvRemovals(${JSON.stringify(consumer)}, []);
        console.log(JSON.stringify({ removals: plan.removals.length, problems: plan.problems }));
      `);

      expect(result).toEqual({ removals: 0, problems: [] });
      expect(lstatSync(env).isFIFO()).toBe(true);
      expect(artifacts(consumer)).toEqual([]);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it('restores without blocking when a FIFO appears after the latest check', () => {
    const { consumer, env } = fixture();
    try {
      const result = runProbe(`
        import { execFileSync } from 'node:child_process';
        import { rmSync } from 'node:fs';
        import { planDevEnvRemovals } from ${JSON.stringify(reconciliationUrl)};
        import { applyDevEnvChanges } from ${JSON.stringify(transactionUrl)};
        const consumer = ${JSON.stringify(consumer)};
        const env = ${JSON.stringify(env)};
        const [removal] = planDevEnvRemovals(consumer, []).removals;
        const result = await applyDevEnvChanges(consumer, [removal], {
          afterDestinationCheck: () => {
            rmSync(env);
            execFileSync('mkfifo', [env]);
          },
        });
        console.log(JSON.stringify(result));
      `);

      expect(result).toEqual({
        ok: false,
        problems: ['packages/db/.env.local changed after preflight'],
      });
      expect(lstatSync(env).isFIFO()).toBe(true);
      expect(artifacts(consumer)).toEqual([]);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });
});
