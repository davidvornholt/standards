// Black-box init, sync, and check for each payload, and the `agents` command
// that keeps a source's own AGENTS.md generated.

import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
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
const CORE_POLICY = '{ "payload": "core" }\n';

const run = (cwd: string, args: ReadonlyArray<string>): RunResult =>
  runProcess('bun', cwd, [ENGINE, ...args], process.env);
const read = (root: string, rel: string): string =>
  readFileSync(join(root, rel), 'utf8');
const lockedPaths = (consumer: string): ReadonlyArray<string> =>
  Object.keys(
    (
      JSON.parse(read(consumer, 'sync-standards.lock')) as {
        files: Record<string, string>;
      }
    ).files,
  ).sort((left, right) => left.localeCompare(right));

const buildUpstream = (): string => {
  const up = mkTmp('payload-up-');
  writeSyncManifest(
    up,
    up,
    ['.github/dependabot.base.yml', 'bun-managed'],
    ['sync-standards.json', 'core-managed'],
  );
  write(up, 'core-managed/a.txt', 'core\n');
  write(up, 'bun-managed/b.txt', 'bun\n');
  write(
    up,
    '.github/dependabot.base.yml',
    [
      'version: 2',
      'updates:',
      '  - package-ecosystem: bun',
      '    directory: /',
      '    schedule:',
      '      interval: weekly',
      '  - package-ecosystem: github-actions',
      '    directory: /',
      '    schedule:',
      '      interval: weekly',
      '',
    ].join('\n'),
  );
  write(up, 'template/biome.jsonc', '{"extends":["./biome.base.jsonc"]}\n');
  write(up, 'template/.github/dependabot.local.yml', '# no additions yet\n');
  return up;
};

const newConsumer = (policy?: string): string => {
  const consumer = mkTmp('payload-cons-');
  execFileSync('git', ['init', '--quiet', consumer]);
  if (policy !== undefined) {
    write(consumer, 'sync-standards.local.json', policy);
  }
  return consumer;
};

const init = (up: string, consumer: string): RunResult =>
  run(consumer, ['init', '--from', up, '--dir', consumer]);

describe('core payload', () => {
  it('mirrors only core paths and composes AGENTS.md from the core part', () => {
    const up = buildUpstream();
    const consumer = newConsumer(CORE_POLICY);

    expect(init(up, consumer).status).toBe(0);

    expect(lockedPaths(consumer)).toEqual([
      'AGENTS.md',
      'core-managed/a.txt',
      'sync-standards.json',
    ]);
    const agents = read(consumer, 'AGENTS.md');
    expect(agents).toContain(AGENTS_PARTS.core);
    expect(agents).not.toContain(AGENTS_PARTS.bun);
    expect(agents.endsWith('\n## Project-specific rules\n')).toBe(true);
    for (const bunOnly of [
      'bun-managed/b.txt',
      'biome.jsonc',
      '.github/dependabot.yml',
      '.github/dependabot.local.yml',
    ]) {
      expect(existsSync(join(consumer, bunOnly))).toBe(false);
    }
  });

  it('passes check without a Bun workspace and catches an edited AGENTS.md', () => {
    const consumer = newConsumer(CORE_POLICY);
    expect(init(buildUpstream(), consumer).status).toBe(0);

    expect(run(consumer, ['check', '--dir', consumer]).status).toBe(0);

    write(consumer, 'AGENTS.md', '# Hand edit\n');
    const drifted = run(consumer, ['check', '--dir', consumer]);
    expect(drifted.status).toBe(1);
    expect(drifted.stderr).toContain('modified: AGENTS.md');
    expect(drifted.stderr).toContain(
      'own rules go below "## Project-specific rules"',
    );
  });

  it('removes Bun paths when a consumer switches to core', () => {
    const up = buildUpstream();
    const consumer = newConsumer();
    expect(init(up, consumer).status).toBe(0);
    expect(read(consumer, 'AGENTS.md')).toContain(AGENTS_PARTS.bun);

    write(consumer, 'sync-standards.local.json', CORE_POLICY);
    const result = run(consumer, ['sync', '--from', up, '--dir', consumer]);

    expect(result.status).toBe(0);
    expect(existsSync(join(consumer, 'bun-managed/b.txt'))).toBe(false);
    expect(read(consumer, 'AGENTS.md')).not.toContain(AGENTS_PARTS.bun);
    expect(lockedPaths(consumer)).toEqual([
      'AGENTS.md',
      'core-managed/a.txt',
      'sync-standards.json',
    ]);
  });
});

describe("a repository's own rules in AGENTS.md", () => {
  it("keeps the repository's own rules below the heading through sync and check", () => {
    const up = buildUpstream();
    const consumer = newConsumer(CORE_POLICY);
    expect(init(up, consumer).status).toBe(0);
    const own = '\n### Own rule\n\nUse tabs.\n';
    write(consumer, 'AGENTS.md', read(consumer, 'AGENTS.md') + own);
    expect(run(consumer, ['check', '--dir', consumer]).status).toBe(0);

    write(up, 'agents-md/core.md', '## Core rules, revised\n');
    const synced = run(consumer, ['sync', '--from', up, '--dir', consumer]);

    expect(synced.status).toBe(0);
    expect(synced.stdout).not.toContain('locally-modified');
    const agents = read(consumer, 'AGENTS.md');
    expect(agents).toContain('## Core rules, revised');
    expect(agents.endsWith(`## Project-specific rules\n${own}`)).toBe(true);
    expect(run(consumer, ['check', '--dir', consumer]).status).toBe(0);
  });

  it('checks only the managed part of AGENTS.md for the Biome directive token', () => {
    const consumer = newConsumer(CORE_POLICY);
    expect(init(buildUpstream(), consumer).status).toBe(0);
    const generated = read(consumer, 'AGENTS.md');
    const token = ['biome', 'ignore'].join('-');

    write(consumer, 'AGENTS.md', `${generated}\nMention ${token} here.\n`);
    expect(run(consumer, ['check', '--dir', consumer]).status).toBe(0);

    write(consumer, 'AGENTS.md', `Mention ${token} here.\n${generated}`);
    const result = run(consumer, ['check', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('forbidden inline Biome directive token');
  });

  it('reports an AGENTS.md that lost the newline after the heading', () => {
    const consumer = newConsumer(CORE_POLICY);
    expect(init(buildUpstream(), consumer).status).toBe(0);
    write(consumer, 'AGENTS.md', read(consumer, 'AGENTS.md').trimEnd());

    const result = run(consumer, ['check', '--dir', consumer]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('modified: AGENTS.md');
  });

  it('refuses to sync over an AGENTS.md without the local heading', () => {
    const up = buildUpstream();
    const consumer = newConsumer(CORE_POLICY);
    write(consumer, 'AGENTS.md', '# Hand-written rules\n');

    const result = init(up, consumer);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'AGENTS.md has no "## Project-specific rules" line',
    );
    expect(read(consumer, 'AGENTS.md')).toBe('# Hand-written rules\n');
    expect(existsSync(join(consumer, 'sync-standards.lock'))).toBe(false);
  });
});

describe('Bun payload', () => {
  it('mirrors both payloads and composes AGENTS.md from both parts', () => {
    const consumer = newConsumer();
    expect(init(buildUpstream(), consumer).status).toBe(0);

    expect(lockedPaths(consumer)).toEqual([
      '.github/dependabot.base.yml',
      'AGENTS.md',
      'bun-managed/b.txt',
      'core-managed/a.txt',
      'sync-standards.json',
    ]);
    expect(read(consumer, 'AGENTS.md')).toContain(
      `${AGENTS_PARTS.core}\n${AGENTS_PARTS.bun}`,
    );
    expect(read(consumer, 'biome.jsonc')).toContain('biome.base.jsonc');
    expect(existsSync(join(consumer, '.github/dependabot.yml'))).toBe(true);
  });
});

describe('agents', () => {
  it('fails on a stale AGENTS.md until --write regenerates it, keeping own rules', () => {
    const up = buildUpstream();
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
    const up = buildUpstream();
    write(up, 'target.md', '# Stale\n');
    rmSync(join(up, 'AGENTS.md'), { force: true });
    symlinkSync('target.md', join(up, 'AGENTS.md'));

    const result = run(up, ['agents', '--write', '--dir', up]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENTS.md is a symlink');
    expect(read(up, 'target.md')).toBe('# Stale\n');
  });

  it('accepts only one of --check or --write', () => {
    const up = buildUpstream();
    const result = run(up, ['agents', '--check', '--write', '--dir', up]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'agents accepts exactly one of --check or --write',
    );
  });
});
