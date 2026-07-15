import type { BigIntStats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { join, parse, relative, resolve, sep } from 'node:path';

type RealDirectoryPath = {
  readonly canonical: string;
  readonly info: BigIntStats;
};

export const inspectRealDirectoryPath = async (
  path: string,
  label: string,
): Promise<RealDirectoryPath> => {
  const lexical = resolve(path);
  const { root } = parse(lexical);
  const parts = relative(root, lexical).split(sep).filter(Boolean);
  const inspectPart = async (
    index: number,
    parent: string,
  ): Promise<BigIntStats> => {
    const current = join(parent, parts[index] ?? '');
    const info = await lstat(current, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(
        `${label} path must contain only real directories: ${lexical}`,
      );
    }
    return index === parts.length - 1 ? info : inspectPart(index + 1, current);
  };
  const info =
    parts.length === 0
      ? await lstat(root, { bigint: true })
      : await inspectPart(0, root);
  const canonical = await realpath(lexical);
  if (canonical !== lexical) {
    throw new Error(`${label} path must be canonical: ${lexical}`);
  }
  return { canonical, info };
};
