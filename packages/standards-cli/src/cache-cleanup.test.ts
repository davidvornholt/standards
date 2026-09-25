import { afterEach, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { parse } from 'yaml';
import {
  ACTUAL_UPSTREAM,
  cleanupTmpDirs,
  mkTmp,
  runProcess,
  write,
} from './cli-test-support';

afterEach(cleanupTmpDirs);

it.each([
  ['Bun', '.bun/install/cache'],
  ['Playwright', '.cache/ms-playwright'],
])(
  'discards primary-key prefix contents before a main %s install',
  (store, path) => {
    const fixture = mkTmp('cache-prefix-');
    write(fixture, `${path}/legacy-executable`, 'poisoned prefix snapshot');
    const workflow = parse(
      readFileSync(
        join(ACTUAL_UPSTREAM, '.github/workflows/standards.yml'),
        'utf8',
      ),
    ) as {
      jobs: { quality: { steps: Array<{ name?: string; run?: string }> } };
    };
    const script = workflow.jobs.quality.steps.find(
      (step) => step.name === `Discard non-exact main ${store} restore`,
    )?.run;
    expect(script).toBeString();
    const result = runProcess(
      'bash',
      fixture,
      ['-euo', 'pipefail', '-c', (script ?? '').replace('$HOME', fixture)],
      { ...process.env },
    );
    expect(result.status).toBe(0);
    expect(existsSync(join(fixture, path))).toBe(false);
  },
);
