import { afterEach, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from 'node:process';
import { openRepositoryRoot } from './sync-filesystem';
import { ensureGitRecoveryArtifactsExcluded } from './sync-git-exclude';

const roots: Array<string> = [];
const ORIGINAL = 'original exclusion\n';

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

it('ignores an inherited Git common-directory override', async () => {
  const rootPath = temporary('standards-git-common-consumer-');
  execFileSync('git', ['-C', rootPath, 'init', '--quiet', '-b', 'main']);
  const consumerExclude = join(rootPath, '.git/info/exclude');
  writeFileSync(consumerExclude, ORIGINAL);
  writeFileSync(join(rootPath, 'consumer.txt'), 'consumer unchanged\n');
  const outside = temporary('standards-git-common-override-');
  const externalCommon = join(outside, 'common');
  cpSync(join(rootPath, '.git'), externalCommon, { recursive: true });
  const previous = env.GIT_COMMON_DIR;
  env.GIT_COMMON_DIR = externalCommon;
  try {
    const root = await openRepositoryRoot(rootPath, 'consumer');
    await ensureGitRecoveryArtifactsExcluded(root);
  } finally {
    env.GIT_COMMON_DIR = previous;
  }

  expect(readFileSync(consumerExclude, 'utf8')).toContain(
    '@davidvornholt/standards recovery artifacts',
  );
  expect(readFileSync(join(externalCommon, 'info/exclude'), 'utf8')).toBe(
    ORIGINAL,
  );
  expect(readFileSync(join(rootPath, 'consumer.txt'), 'utf8')).toBe(
    'consumer unchanged\n',
  );
});
