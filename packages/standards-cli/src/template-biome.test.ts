// Fixture tests for the seeded Biome wrapper: a consumer initialized from the
// template must survive a Claude agent worktree appearing under
// .claude/worktrees — a full checkout whose own root biome.jsonc Biome would
// otherwise reject as a nested root configuration.

import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '../../..');
const BIOME = join(REPO_ROOT, 'node_modules/.bin/biome');
const BASE = readFileSync(join(REPO_ROOT, 'biome.base.jsonc'), 'utf8');
const WRAPPER = readFileSync(join(REPO_ROOT, 'template/biome.jsonc'), 'utf8');
const WORKTREE_ENTRY = ', "!!.claude/worktrees"';

type RunResult = { output: string; status: number };

const tmps: Array<string> = [];
afterEach(() => {
  for (const dir of tmps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const write = (root: string, rel: string, content: string): void => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
};

// A consumer checkout with a complete parallel checkout in a Claude worktree:
// the nested wrapper's extends target resolves, so the only possible failure
// is the nested-root discovery itself.
const buildFixture = (wrapper: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'template-biome-'));
  tmps.push(dir);
  execFileSync('git', ['-C', dir, 'init', '--quiet']);
  write(dir, 'biome.base.jsonc', BASE);
  write(dir, 'biome.jsonc', wrapper);
  write(dir, 'src/answer.ts', 'export const answer = 42;\n');
  write(dir, '.claude/worktrees/task/biome.base.jsonc', BASE);
  write(dir, '.claude/worktrees/task/biome.jsonc', WRAPPER);
  write(dir, '.claude/worktrees/task/src/wip.ts', 'export const wip = 1;\n');
  return dir;
};

const check = (dir: string): RunResult => {
  try {
    const stdout = execFileSync(BIOME, ['check', '.'], {
      cwd: dir,
      encoding: 'utf8',
    });
    return { output: stdout, status: 0 };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return {
      output: `${e.stdout ?? ''}${e.stderr ?? ''}`,
      status: e.status ?? 1,
    };
  }
};

describe('template biome wrapper', () => {
  it('keeps a worktree biome.jsonc undiscovered as a nested root', () => {
    expect(WRAPPER).toContain(WORKTREE_ENTRY);
    const result = check(buildFixture(WRAPPER));
    expect(result.output).not.toContain('nested root configuration');
    expect(result.status).toBe(0);
  });

  it('fails on the nested root without the worktree ignore, proving the entry is load-bearing', () => {
    const stripped = WRAPPER.replace(WORKTREE_ENTRY, '');
    expect(stripped).not.toBe(WRAPPER);
    const result = check(buildFixture(stripped));
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('nested root configuration');
  });
});
