import { afterEach, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRepositoryRoot } from './sync-filesystem';
import { ensureGitRecoveryArtifactsExcluded } from './sync-git-exclude';

const roots: Array<string> = [];
const ORIGINAL = 'original exclusion\n';

afterEach(() => {
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

const repository = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'standards-git-root-generation-'));
  roots.push(root);
  execFileSync('git', ['-C', root, 'init', '--quiet', '-b', 'main']);
  writeFileSync(join(root, '.git/info/exclude'), ORIGINAL);
  return root;
};

const replaceRepository = (
  root: string,
): { readonly exclude: string; readonly original: string } => {
  const original = `${root}-original`;
  renameSync(root, original);
  roots.push(original);
  mkdirSync(root);
  execFileSync('git', ['-C', root, 'init', '--quiet', '-b', 'main']);
  writeFileSync(join(root, 'replacement.txt'), 'replacement unchanged\n');
  return { exclude: join(root, '.git/info/exclude'), original };
};

const replacementState = (exclude: string) => ({
  artifacts: readdirSync(join(exclude, '..')).filter((name) =>
    name.includes('.standards-'),
  ),
  consumer: readFileSync(join(exclude, '../../../replacement.txt'), 'utf8'),
  exclude: readFileSync(exclude, 'utf8'),
});

it('rejects root replacement before Git metadata discovery', async () => {
  const root = repository();
  const opened = await openRepositoryRoot(root, 'consumer');
  const replacement = replaceRepository(root);
  const before = replacementState(replacement.exclude);

  await expect(ensureGitRecoveryArtifactsExcluded(opened)).rejects.toThrow(
    'consumer root changed after preflight',
  );

  expect(replacementState(replacement.exclude)).toEqual(before);
});

it('rejects root replacement at the final publication boundary', async () => {
  const root = repository();
  const opened = await openRepositoryRoot(root, 'consumer');
  const replacement = {
    exclude: join(root, '.git/info/exclude'),
    original: `${root}-original`,
  };
  let replacementExclude = '';

  await expect(
    ensureGitRecoveryArtifactsExcluded(opened, {
      beforePublication: () => {
        replaceRepository(root);
        replacementExclude = readFileSync(replacement.exclude, 'utf8');
        return Promise.resolve();
      },
    }),
  ).rejects.toThrow('consumer root changed after preflight');

  expect(replacementState(replacement.exclude)).toEqual({
    artifacts: [],
    consumer: 'replacement unchanged\n',
    exclude: replacementExclude,
  });
  expect(
    readFileSync(join(replacement.original, '.git/info/exclude'), 'utf8'),
  ).toBe(ORIGINAL);
});
