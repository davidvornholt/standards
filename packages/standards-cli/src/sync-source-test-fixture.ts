import { existsSync } from 'node:fs';
import { inspectRepositoryFiles } from './sync-file-inspection';
import { openRepositoryRoot } from './sync-filesystem';
import { applyRepositoryMutations } from './sync-mutations';
import {
  readFixture,
  requiredState,
  temporaryRoot,
  transactionArtifacts,
  writeFixture,
} from './sync-mutations-test-helpers';
import {
  type RepositoryTreeSet,
  type SourceFile,
  snapshotRepositoryTreeSets,
} from './sync-source';
import {
  type SourceSelectionHooks,
  selectSourceTrees,
} from './sync-source-selection';
import type {
  SourceFileExpectation,
  SourceSnapshotHooks,
} from './sync-source-types';

export type SourceFixture = Readonly<{
  consumer: string;
  source: string;
}>;

type SynchronizeOptions = {
  readonly expectedFiles?: ReadonlyMap<string, SourceFileExpectation>;
  readonly hooks?: SourceSnapshotHooks;
  readonly sets?: ReadonlyArray<RepositoryTreeSet>;
};

const DEFAULT_SETS: ReadonlyArray<RepositoryTreeSet> = [
  { outputBase: null, roots: ['managed'] },
  { outputBase: 'seed', roots: ['seed'] },
];

export const setupSourceFixture = (initialized = true): SourceFixture => {
  const source = temporaryRoot();
  writeFixture(source, 'managed/a.txt', 'old\n');
  writeFixture(source, 'managed/b.txt', 'sibling\n');
  writeFixture(source, 'seed/seed.txt', 'seed\n');
  writeFixture(
    source,
    'sync-standards.json',
    JSON.stringify({
      paths: ['managed', 'sync-standards.json'],
      seedDir: 'seed',
      upstream: 'https://example.com/standards.git',
    }),
  );
  const consumer = temporaryRoot();
  writeFixture(consumer, 'managed/a.txt', 'consumer\n');
  if (initialized) {
    writeFixture(consumer, 'sync-standards.lock', 'old lock\n');
  }
  return { consumer, source };
};

const applySelectedSource = async (
  { consumer }: SourceFixture,
  managed: ReadonlyMap<string, SourceFile>,
): Promise<void> => {
  const selected = managed?.get('managed/a.txt');
  if (selected === undefined) {
    throw new Error('Test source snapshot omitted managed/a.txt');
  }
  const consumerRoot = await openRepositoryRoot(consumer, 'consumer');
  const states = await inspectRepositoryFiles(consumerRoot, [
    'managed/a.txt',
    'sync-standards.lock',
  ]);
  await applyRepositoryMutations({
    deletes: [],
    prunes: [],
    root: consumerRoot,
    writes: [
      {
        before: requiredState(states, 'managed/a.txt'),
        contents: selected.contents,
        mode: selected.mode,
        rel: 'managed/a.txt',
      },
      {
        before: requiredState(states, 'sync-standards.lock'),
        contents: Buffer.from('new lock\n'),
        mode: 0o644,
        rel: 'sync-standards.lock',
      },
    ],
  });
};

const synchronize = async (
  fixture: SourceFixture,
  options: SynchronizeOptions,
): Promise<void> => {
  const sourceRoot = await openRepositoryRoot(fixture.source, 'source');
  const [managed] = await snapshotRepositoryTreeSets(
    sourceRoot,
    options.sets ?? DEFAULT_SETS,
    new Set(),
    { expectedFiles: options.expectedFiles, hooks: options.hooks },
  );
  await applySelectedSource(fixture, managed);
};

const attempt = async (
  fixture: SourceFixture,
  operation: () => Promise<void>,
) => {
  let error: string | null = null;
  try {
    await operation();
  } catch (cause) {
    error = String(cause);
  }
  const lockPath = `${fixture.consumer}/sync-standards.lock`;
  return {
    artifacts: transactionArtifacts(fixture.consumer),
    error,
    lock: existsSync(lockPath)
      ? readFixture(fixture.consumer, 'sync-standards.lock')
      : null,
    managed: readFixture(fixture.consumer, 'managed/a.txt'),
  };
};

export const attemptSourceSynchronization = async (
  fixture: SourceFixture,
  options: SynchronizeOptions,
) => attempt(fixture, () => synchronize(fixture, options));

export const attemptProductionSourceSelection = async (
  fixture: SourceFixture,
  hooks: SourceSelectionHooks,
) =>
  attempt(fixture, async () => {
    const sourceRoot = await openRepositoryRoot(fixture.source, 'source');
    const { managed } = await selectSourceTrees(sourceRoot, new Set(), hooks);
    await applySelectedSource(fixture, managed);
  });
