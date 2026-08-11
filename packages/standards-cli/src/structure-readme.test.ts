import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { collectWorkspaceReadmeProblems } from './structure-readme';
import {
  cleanupStructureTmps,
  newStructureTmp,
  writeInto as write,
} from './structure-test-support';

afterEach(cleanupStructureTmps);

const MANIFEST_REQUIREMENT =
  'sync-standards.json: must contain a JSON object with a "paths" array of strings; the structure gate reads it to tell canonical workspaces from repo-owned ones';
const readmeProblem = (rel: string): string =>
  `${rel}: repo-owned workspace must have a non-empty README.md`;

const buildRepo = (paths: ReadonlyArray<unknown> | null): string => {
  const dir = newStructureTmp('structure-readme-');
  if (paths !== null) {
    write(dir, 'sync-standards.json', JSON.stringify({ paths }));
  }
  write(dir, 'apps/web/README.md', '# web\n');
  write(dir, 'packages/owned/README.md', '   \n');
  return dir;
};

describe('collectWorkspaceReadmeProblems', () => {
  it('accepts documented workspaces and rejects missing or blank READMEs', async () => {
    const dir = buildRepo([]);
    const problems = await collectWorkspaceReadmeProblems(dir, 'consumer', [
      'apps/web',
      'packages/owned',
      'packages/undocumented',
    ]);
    expect(problems).toEqual([
      readmeProblem('packages/owned'),
      readmeProblem('packages/undocumented'),
    ]);
  });

  it('exempts canonical workspaces listed in sync-standards.json', async () => {
    const dir = buildRepo(['AGENTS.md', 'packages/typescript-config/']);
    const problems = await collectWorkspaceReadmeProblems(dir, 'consumer', [
      'apps/web',
      'packages/typescript-config',
    ]);
    expect(problems).toEqual([]);
  });

  it('holds the source profile to the rule even for synced workspaces', async () => {
    const dir = buildRepo(['packages/typescript-config']);
    const problems = await collectWorkspaceReadmeProblems(dir, 'source', [
      'packages/typescript-config',
    ]);
    expect(problems).toEqual([readmeProblem('packages/typescript-config')]);
  });

  it.each([
    ['missing manifest', null],
    ['non-string paths entry', [true]],
  ])(
    'fails closed on a %s instead of guessing ownership',
    async (_label, paths) => {
      const dir = buildRepo(paths as ReadonlyArray<unknown> | null);
      const problems = await collectWorkspaceReadmeProblems(dir, 'consumer', [
        'apps/web',
      ]);
      expect(problems).toEqual([MANIFEST_REQUIREMENT]);
    },
  );

  it('fails closed when the manifest has no paths array', async () => {
    const dir = buildRepo(null);
    write(dir, 'sync-standards.json', JSON.stringify({ upstream: 'x' }));
    expect(
      await collectWorkspaceReadmeProblems(dir, 'consumer', ['apps/web']),
    ).toEqual([MANIFEST_REQUIREMENT]);
  });

  it('does not read the manifest under the source profile', async () => {
    const dir = newStructureTmp('structure-readme-');
    write(dir, 'apps/web/README.md', '# web\n');
    rmSync(join(dir, 'sync-standards.json'), { force: true });
    expect(
      await collectWorkspaceReadmeProblems(dir, 'source', ['apps/web']),
    ).toEqual([]);
  });
});
