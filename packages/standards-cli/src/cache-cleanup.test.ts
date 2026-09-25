import { afterEach, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  cleanupTmpDirs,
  mkTmp,
  runProcess,
  STANDARDS_WORKFLOW,
  write,
  yamlRunScript,
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
    const script = yamlRunScript(
      STANDARDS_WORKFLOW,
      `Discard non-exact main ${store} restore`,
    ).replace('$HOME', fixture);
    const result = runProcess(
      'bash',
      fixture,
      ['-euo', 'pipefail', '-c', script],
      { ...process.env },
    );
    expect(result.status).toBe(0);
    expect(existsSync(join(fixture, path))).toBe(false);
  },
);
