import { afterEach, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRepositoryRoot } from './sync-filesystem';
import { ensureGitRecoveryArtifactsExcluded } from './sync-git-exclude';

const roots: Array<string> = [];
const ORIGINAL = 'original exclusion\n';
const OUTSIDE = 'outside must stay unchanged\n';

afterEach(() => {
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

const temporary = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
};

const repository = (): string => {
  const root = temporary('standards-git-boundary-');
  execFileSync('git', ['-C', root, 'init', '--quiet', '-b', 'main']);
  writeFileSync(join(root, '.git/info/exclude'), ORIGINAL);
  writeFileSync(join(root, 'consumer.txt'), 'consumer unchanged\n');
  return root;
};

const ensure = async (
  rootPath: string,
  hooks: Parameters<typeof ensureGitRecoveryArtifactsExcluded>[1] = {},
): Promise<void> => {
  const root = await openRepositoryRoot(rootPath, 'consumer');
  await ensureGitRecoveryArtifactsExcluded(root, hooks);
};

const outsideFile = (): {
  readonly directory: string;
  readonly path: string;
} => {
  const directory = temporary('standards-git-outside-');
  const path = join(directory, 'outside');
  writeFileSync(path, OUTSIDE);
  return { directory, path };
};

const unchangedContents = (
  root: string,
  outside: string,
): ReadonlyArray<string> => [
  readFileSync(outside, 'utf8'),
  readFileSync(join(root, 'consumer.txt'), 'utf8'),
];

it('rejects a symbolic-link exclude target without touching its referent', async () => {
  const root = repository();
  const outside = outsideFile();
  const exclude = join(root, '.git/info/exclude');
  rmSync(exclude);
  symlinkSync(outside.path, exclude);

  await expect(ensure(root)).rejects.toThrow('exclusion target must be real');

  expect(lstatSync(exclude).isSymbolicLink()).toBe(true);
  expect(unchangedContents(root, outside.path)).toEqual([
    OUTSIDE,
    'consumer unchanged\n',
  ]);
});

it('rejects a symbolic-link info parent without touching its contents', async () => {
  const root = repository();
  const outside = outsideFile();
  writeFileSync(join(outside.directory, 'exclude'), OUTSIDE);
  rmSync(join(root, '.git/info'), { recursive: true });
  symlinkSync(outside.directory, join(root, '.git/info'));

  await expect(ensure(root)).rejects.toThrow();

  expect(readFileSync(join(outside.directory, 'exclude'), 'utf8')).toBe(
    OUTSIDE,
  );
  expect(unchangedContents(root, outside.path)).toEqual([
    OUTSIDE,
    'consumer unchanged\n',
  ]);
});

it('restores a target replaced after validation but before exchange', async () => {
  const root = repository();
  const outside = outsideFile();
  const info = join(root, '.git/info');
  await expect(
    ensure(root, {
      beforeExchange: () => {
        renameSync(join(info, 'exclude'), join(info, 'exclude-original'));
        symlinkSync(outside.path, join(info, 'exclude'));
        return Promise.resolve();
      },
    }),
  ).rejects.toThrow('target changed during replacement');

  expect(readFileSync(join(info, 'exclude-original'), 'utf8')).toBe(ORIGINAL);
  expect(lstatSync(join(info, 'exclude')).isSymbolicLink()).toBe(true);
  expect(
    readdirSync(info).filter((name) => name.includes('.standards-')),
  ).toHaveLength(1);
  expect(unchangedContents(root, outside.path)).toEqual([
    OUTSIDE,
    'consumer unchanged\n',
  ]);
});

it('rejects an info-parent swap before creating a temporary file', async () => {
  const root = repository();
  const outside = outsideFile();
  const git = join(root, '.git');
  await expect(
    ensure(root, {
      beforeTemporaryWrite: () => {
        renameSync(join(git, 'info'), join(git, 'info-original'));
        symlinkSync(outside.directory, join(git, 'info'));
        return Promise.resolve();
      },
    }),
  ).rejects.toThrow();

  expect(readFileSync(join(git, 'info-original/exclude'), 'utf8')).toBe(
    ORIGINAL,
  );
  expect(readdirSync(join(git, 'info-original'))).toEqual(['exclude']);
  expect(unchangedContents(root, outside.path)).toEqual([
    OUTSIDE,
    'consumer unchanged\n',
  ]);
});

it('updates the common exclusion file from a linked worktree', async () => {
  const main = repository();
  execFileSync('git', ['-C', main, 'add', 'consumer.txt']);
  execFileSync('git', [
    '-C',
    main,
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'initial',
  ]);
  const parent = temporary('standards-linked-worktree-');
  const linked = join(parent, 'linked');
  execFileSync('git', [
    '-C',
    main,
    'worktree',
    'add',
    '--quiet',
    '--detach',
    linked,
  ]);

  await ensure(linked);

  expect(readFileSync(join(main, '.git/info/exclude'), 'utf8')).toContain(
    '@davidvornholt/standards recovery artifacts',
  );
});
