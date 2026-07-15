import type { BigIntStats } from 'node:fs';
import { assertFilesystemIdentityComponent } from './sync-node-identity';

export type NodeGeneration = {
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
};

export const nodeGeneration = (info: BigIntStats): NodeGeneration => ({
  ctimeNs: info.ctimeNs,
  dev: assertFilesystemIdentityComponent(info.dev, 'filesystem device'),
  ino: assertFilesystemIdentityComponent(info.ino, 'filesystem inode'),
  mode: info.mode,
  mtimeNs: info.mtimeNs,
  nlink: info.nlink,
  size: info.size,
});

export const nodeGenerationsMatch = (
  left: NodeGeneration,
  right: NodeGeneration,
): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;
