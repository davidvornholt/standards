import type { PinnedDirectory } from './sync-directory-handles';
import type { NodeGeneration } from './sync-node-generation';

export type SourceFile = {
  readonly contents: Buffer;
  readonly mode: number;
};

export type SourceDirectoryRecord = {
  readonly entries: ReadonlyArray<string>;
  readonly generation: NodeGeneration;
  readonly rel: string;
};

export type SourceFileRecord = SourceFile & {
  readonly generation: NodeGeneration;
  readonly rel: string;
};

export type OpenSourceDirectory = {
  readonly directory: PinnedDirectory;
  readonly record: SourceDirectoryRecord;
};

export type SourceFileExpectation = {
  readonly contents: Buffer;
  readonly generation: NodeGeneration;
};

export type SourceSnapshotHooks = {
  readonly afterDirectoryClose?: (rel: string) => Promise<void>;
  readonly afterDirectoryOpen?: (rel: string) => Promise<void>;
  readonly afterFileClose?: (rel: string) => Promise<void>;
  readonly afterFileOpen?: (rel: string) => Promise<void>;
  readonly afterFileRead?: (rel: string) => Promise<void>;
  readonly beforeFileRead?: (rel: string) => Promise<void>;
  readonly beforeFinalValidation?: () => Promise<void>;
};

export type SourceSnapshotOptions = {
  readonly expectedFiles?: ReadonlyMap<string, SourceFileExpectation>;
  readonly hooks?: SourceSnapshotHooks;
};
