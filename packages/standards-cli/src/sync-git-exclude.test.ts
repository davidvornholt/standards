import { afterEach, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openRepositoryRoot } from './sync-filesystem';
import { ensureGitRecoveryArtifactsExcluded } from './sync-git-exclude';

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const repository = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'standards-git-exclude-'));
  roots.push(root);
  execFileSync('git', ['-C', root, 'init', '--quiet', '-b', 'main']);
  return root;
};

const write = (root: string, relative: string): void => {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'fixture\n');
};

const isIgnored = (root: string, relative: string): boolean =>
  spawnSync('git', ['-C', root, 'check-ignore', '--quiet', relative]).status ===
  0;

it('excludes only reserved recovery artifact namespaces', async () => {
  const rootPath = repository();
  const root = await openRepositoryRoot(rootPath, 'consumer');

  await ensureGitRecoveryArtifactsExcluded(root);

  const reserved = [
    '.standards-transaction',
    'nested/.standards-transaction-cleanup',
    '.standards-transaction-owner-reservation',
    '.standards-transaction-reservation',
    '.standards-transaction-reservation.11111111-1111-4111-8111-111111111111.tmp',
    'nested/OWNER.11111111-1111-4111-8111-111111111111.tmp',
    '.standards-transaction-publication-fixture',
    '.standards-owner-publication-fixture',
    '.standards-parent-fixture',
    'nested/.standards-removal-fixture',
  ] as const;
  const lookalikes = [
    '.standards-transaction-user',
    '.standards-transaction-reservation.11111111-1111-3111-8111-111111111111.tmp',
    'OWNER.11111111-1111-3111-8111-111111111111.tmp',
    '.standards-transaction-publication',
    '.standards-owner-publication',
    '.standards-parent',
    '.standards-removal',
  ] as const;
  for (const relative of [...reserved, ...lookalikes]) {
    write(rootPath, relative);
  }

  expect(reserved.every((relative) => isIgnored(rootPath, relative))).toBe(
    true,
  );
  expect(lookalikes.some((relative) => isIgnored(rootPath, relative))).toBe(
    false,
  );
});

it('keeps the owned block last and updates it idempotently', async () => {
  const rootPath = repository();
  const exclude = join(rootPath, '.git/info/exclude');
  writeFileSync(exclude, 'user-artifact\n!.standards-removal-fixture\n');
  const root = await openRepositoryRoot(rootPath, 'consumer');

  await ensureGitRecoveryArtifactsExcluded(root);
  const once = readFileSync(exclude, 'utf8');
  await ensureGitRecoveryArtifactsExcluded(root);

  expect(readFileSync(exclude, 'utf8')).toBe(once);
  expect(once).toStartWith('user-artifact\n!.standards-removal-fixture\n\n');
  write(rootPath, '.standards-removal-fixture');
  expect(isIgnored(rootPath, '.standards-removal-fixture')).toBe(true);
});

it('atomically creates a missing common exclusion file', async () => {
  const rootPath = repository();
  const exclude = join(rootPath, '.git/info/exclude');
  rmSync(exclude);
  const root = await openRepositoryRoot(rootPath, 'consumer');

  await ensureGitRecoveryArtifactsExcluded(root);

  expect(readFileSync(exclude, 'utf8')).toContain(
    '@davidvornholt/standards recovery artifacts',
  );
});
