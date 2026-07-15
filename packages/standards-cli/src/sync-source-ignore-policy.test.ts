import { afterEach, expect, it } from 'bun:test';
import { openRepositoryRoot } from './sync-filesystem';
import { cleanupFixtures, writeFixture } from './sync-mutations-test-helpers';
import {
  IGNORED_SOURCE_DIRECTORY_NAMES,
  snapshotRepositoryTreeSets,
} from './sync-source';
import { setupSourceFixture } from './sync-source-test-fixture';

const ignoredRootCases = [...IGNORED_SOURCE_DIRECTORY_NAMES].flatMap(
  (name) => [name, `managed/${name}/nested`] as const,
);
const ignoredOutputBaseCases = [...IGNORED_SOURCE_DIRECTORY_NAMES].flatMap(
  (name) => [name, `output/${name}/nested`] as const,
);
const ignoredComponent = (path: string): string | undefined =>
  path.split('/').find((part) => IGNORED_SOURCE_DIRECTORY_NAMES.has(part));

afterEach(cleanupFixtures);

it.each(
  ignoredRootCases,
)('rejects explicit ignored snapshot root %s before traversal', async (rel) => {
  const fixture = setupSourceFixture();
  writeFixture(fixture.source, `${rel}/proof.txt`, 'must not read\n');
  const root = await openRepositoryRoot(fixture.source, 'source');
  let opened = 0;

  await expect(
    snapshotRepositoryTreeSets(
      root,
      [{ outputBase: null, roots: [rel] }],
      IGNORED_SOURCE_DIRECTORY_NAMES,
      {
        hooks: {
          afterDirectoryOpen: () => {
            opened += 1;
            return Promise.resolve();
          },
        },
      },
    ),
  ).rejects.toThrow(
    `source snapshot root must not contain ignored path component "${ignoredComponent(rel)}": ${rel}`,
  );
  expect(opened).toBe(0);
});

it.each(
  ignoredOutputBaseCases,
)('rejects explicit ignored snapshot output base %s before traversal', async (outputBase) => {
  const fixture = setupSourceFixture();
  writeFixture(fixture.source, `${outputBase}/seed.txt`, 'must not read\n');
  const root = await openRepositoryRoot(fixture.source, 'source');
  let opened = 0;

  await expect(
    snapshotRepositoryTreeSets(
      root,
      [{ outputBase, roots: [outputBase] }],
      IGNORED_SOURCE_DIRECTORY_NAMES,
      {
        hooks: {
          afterDirectoryOpen: () => {
            opened += 1;
            return Promise.resolve();
          },
        },
      },
    ),
  ).rejects.toThrow(
    `source snapshot base must not contain ignored path component "${ignoredComponent(outputBase)}": ${outputBase}`,
  );
  expect(opened).toBe(0);
});

it('continues to filter ignored directory entries during ordinary traversal', async () => {
  const fixture = setupSourceFixture();
  for (const name of IGNORED_SOURCE_DIRECTORY_NAMES) {
    writeFixture(fixture.source, `managed/${name}/ignored.txt`, 'ignored\n');
  }
  const root = await openRepositoryRoot(fixture.source, 'source');

  const [managed] = await snapshotRepositoryTreeSets(
    root,
    [{ outputBase: null, roots: ['managed'] }],
    IGNORED_SOURCE_DIRECTORY_NAMES,
  );

  expect([...managed.keys()].sort()).toEqual([
    'managed/a.txt',
    'managed/b.txt',
  ]);
});

it('continues to treat absent non-ignored nested roots as empty trees', async () => {
  const fixture = setupSourceFixture();
  const root = await openRepositoryRoot(fixture.source, 'source');

  const [managed] = await snapshotRepositoryTreeSets(
    root,
    [{ outputBase: null, roots: ['managed/future/nested'] }],
    IGNORED_SOURCE_DIRECTORY_NAMES,
  );

  expect(managed).toEqual(new Map());
});
