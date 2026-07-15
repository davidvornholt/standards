import { inspectRepositoryFileWithGeneration } from './sync-file-inspection';
import {
  assertRepositoryRelativePath,
  type RepositoryRoot,
} from './sync-filesystem';
import type { NodeGeneration } from './sync-node-generation';
import { type SourceFile, snapshotRepositoryTreeSets } from './sync-source';
import type { SourceSnapshotHooks } from './sync-source-types';

export type Manifest = {
  readonly paths: ReadonlyArray<string>;
  readonly seedDir: string;
  readonly syncPolicyContractVersion: unknown;
  readonly upstream: string;
};

export type SourceSelectionHooks = {
  readonly afterManifestLoad?: () => Promise<void>;
  readonly snapshot?: SourceSnapshotHooks;
};

type LoadedManifest = {
  readonly contents: Buffer;
  readonly generation: NodeGeneration;
  readonly manifest: Manifest;
};

const parseManifest = (raw: unknown): Manifest => {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('sync-standards.json must be a JSON object');
  }
  const value = raw as Record<string, unknown>;
  if (
    typeof value.upstream !== 'string' ||
    value.upstream.length === 0 ||
    typeof value.seedDir !== 'string'
  ) {
    throw new Error(
      'sync-standards.json requires non-empty string "upstream" and string "seedDir"',
    );
  }
  if (
    !(
      Array.isArray(value.paths) &&
      value.paths.every((path) => typeof path === 'string')
    )
  ) {
    throw new Error('sync-standards.json requires a string array "paths"');
  }
  const paths = value.paths as ReadonlyArray<string>;
  assertRepositoryRelativePath(value.seedDir, 'sync-standards.json "seedDir"');
  for (const path of paths) {
    assertRepositoryRelativePath(path, 'sync-standards.json managed path');
  }
  if (new Set(paths).size !== paths.length) {
    throw new Error('sync-standards.json managed paths must be unique');
  }
  return {
    paths,
    seedDir: value.seedDir,
    syncPolicyContractVersion: value.syncPolicyContractVersion,
    upstream: value.upstream,
  };
};

const loadManifestRecord = async (
  root: RepositoryRoot,
): Promise<LoadedManifest> => {
  const { generation, state } = await inspectRepositoryFileWithGeneration(
    root,
    'sync-standards.json',
  );
  if (state.contents === null || generation === null) {
    throw new Error(`Manifest not found in ${root.label}`);
  }
  return {
    contents: state.contents,
    generation,
    manifest: parseManifest(
      JSON.parse(state.contents.toString('utf8')) as unknown,
    ),
  };
};

export const loadSourceManifest = async (
  root: RepositoryRoot,
): Promise<Manifest> => (await loadManifestRecord(root)).manifest;

export const selectSourceTrees = async (
  root: RepositoryRoot,
  ignoredNames: ReadonlySet<string>,
  hooks: SourceSelectionHooks = {},
): Promise<{
  readonly managed: ReadonlyMap<string, SourceFile>;
  readonly manifest: Manifest;
  readonly seeds: ReadonlyMap<string, SourceFile>;
}> => {
  const loaded = await loadManifestRecord(root);
  await hooks.afterManifestLoad?.();
  const { manifest } = loaded;
  const [managed, seeds] = await snapshotRepositoryTreeSets(
    root,
    [
      { outputBase: null, roots: manifest.paths },
      { outputBase: manifest.seedDir, roots: [manifest.seedDir] },
    ],
    ignoredNames,
    {
      expectedFiles: new Map([
        [
          'sync-standards.json',
          { contents: loaded.contents, generation: loaded.generation },
        ],
      ]),
      hooks: hooks.snapshot,
    },
  );
  return { managed, manifest, seeds };
};
