import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const ROOT = join(import.meta.dir, '../../..');
const PREFLIGHT = join(
  ROOT,
  '.github/actions/standards-sync-preflight/index.mjs',
);
const CLI = join(ROOT, 'packages/standards-cli/src/cli.ts');
const LOCK = join(ROOT, 'sync-standards.lock');
const EVENT_NAME_VARIABLE = 'GITHUB_EVENT_NAME';
const OUTPUT_VARIABLE = 'GITHUB_OUTPUT';
const WORKSPACE_VARIABLE = 'GITHUB_WORKSPACE';
const readLock = (): string | undefined =>
  existsSync(LOCK) ? readFileSync(LOCK, 'utf8') : undefined;

describe('standards source workspace', () => {
  it('passes real-root scheduled and repository-dispatch preflight', () => {
    for (const eventName of ['schedule', 'repository_dispatch']) {
      const directory = mkdtempSync(join(tmpdir(), 'standards-source-'));
      const output = join(directory, 'github-output');
      try {
        const environment = { ...process.env };
        environment[EVENT_NAME_VARIABLE] = eventName;
        environment[OUTPUT_VARIABLE] = output;
        environment[WORKSPACE_VARIABLE] = ROOT;
        const result = spawnSync('node', [PREFLIGHT], {
          cwd: ROOT,
          encoding: 'utf8',
          env: environment,
        });

        expect(result.status).toBe(0);
        expect(readFileSync(output, 'utf8')).toBe('run_sync=true\n');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('keeps a real-root local dry run as a no-op', () => {
    const lockBefore = readLock();
    const result = spawnSync('bun', [CLI, 'sync', '--from', '.', '--dry-run'], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('dry run: already in sync; no changes');
    expect(readLock()).toBe(lockBefore);
  });
});
