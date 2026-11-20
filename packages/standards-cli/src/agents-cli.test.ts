// Black-box tests of the `agents` command, which keeps the standards source's
// own AGENTS.md generated from its parts.

import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  AGENTS_PARTS,
  cleanupTmpDirs,
  mkTmp,
  type RunResult,
  runProcess,
  write,
  writeSyncManifest,
} from './cli-test-support';

afterEach(cleanupTmpDirs);

const ENGINE = join(import.meta.dir, 'cli.ts');

const run = (cwd: string, args: ReadonlyArray<string>): RunResult =>
  runProcess('bun', cwd, [ENGINE, ...args], process.env);
const read = (root: string, rel: string): string =>
  readFileSync(join(root, rel), 'utf8');

const buildSource = (): string => {
  const source = mkTmp('agents-source-');
  writeSyncManifest(source, source, []);
  return source;
};

describe('agents', () => {
  it('fails on a stale AGENTS.md until --write regenerates it, keeping own rules', () => {
    const up = buildSource();
    const own = '\n### Own rule\n';
    write(up, 'AGENTS.md', `# Stale\n\n## Project-specific rules\n${own}`);

    const stale = run(up, ['agents', '--dir', up]);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('does not match its parts');

    expect(run(up, ['agents', '--write', '--dir', up]).status).toBe(0);
    const agents = read(up, 'AGENTS.md');
    expect(agents).toContain(`${AGENTS_PARTS.core}\n${AGENTS_PARTS.bun}`);
    expect(agents.endsWith(`## Project-specific rules\n${own}`)).toBe(true);
    expect(run(up, ['agents', '--check', '--dir', up]).status).toBe(0);
  });

  it('refuses to write through a symlinked AGENTS.md', () => {
    const up = buildSource();
    write(up, 'target.md', '# Stale\n');
    rmSync(join(up, 'AGENTS.md'), { force: true });
    symlinkSync('target.md', join(up, 'AGENTS.md'));

    const result = run(up, ['agents', '--write', '--dir', up]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENTS.md is a symlink');
    expect(read(up, 'target.md')).toBe('# Stale\n');
  });

  it('accepts only one of --check or --write', () => {
    const up = buildSource();
    const result = run(up, ['agents', '--check', '--write', '--dir', up]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'agents accepts exactly one of --check or --write',
    );
  });
});
