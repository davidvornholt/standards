import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type DevEnvWrite = {
  readonly rel: string;
  readonly content: string;
};

type DevEnvPathIdentity = {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
};

export type DevEnvDestination = {
  readonly write: DevEnvWrite;
  readonly dest: string;
  readonly previous: Stats | null;
  readonly temp: string;
  readonly backup: string;
  readonly parents: ReadonlyArray<DevEnvPathIdentity>;
  readonly realParent: string;
  readonly realRoot: string;
  backupCreated: boolean;
  committed: boolean;
};

type PreflightResult =
  | {
      readonly ok: true;
      readonly destinations: ReadonlyArray<DevEnvDestination>;
    }
  | { readonly ok: false; readonly problems: ReadonlyArray<string> };

const containedBy = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

export const devEnvStatOrNull = async (path: string): Promise<Stats | null> => {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

const inspectDestination = async (
  root: string,
  realRoot: string,
  write: DevEnvWrite,
): Promise<string | DevEnvDestination> => {
  const dest = resolve(root, write.rel);
  if (!containedBy(root, dest)) {
    return `${write.rel} escapes the consumer repository`;
  }
  const paths = dirname(write.rel)
    .split(sep)
    .map((_segment, index, segments) =>
      join(root, ...segments.slice(0, index + 1)),
    );
  const parentPaths = [root, ...paths];
  const parents = await Promise.all(parentPaths.map(devEnvStatOrNull));
  if (
    parents.some(
      (entry) =>
        entry === null || !entry.isDirectory() || entry.isSymbolicLink(),
    )
  ) {
    return `${write.rel} has an unsafe destination directory`;
  }
  const realParent = await realpath(dirname(dest));
  if (!containedBy(realRoot, realParent)) {
    return `${write.rel} resolves outside the consumer repository`;
  }
  const previous = await devEnvStatOrNull(dest);
  if (previous !== null && (!previous.isFile() || previous.isSymbolicLink())) {
    return `${write.rel} must be absent or a regular file, not a symlink or other file type`;
  }
  const suffix = randomUUID();
  return {
    write,
    dest,
    previous,
    temp: join(dirname(dest), `.env.local.standards-${suffix}.tmp`),
    backup: join(dirname(dest), `.env.local.standards-${suffix}.bak`),
    parents: parents.map((entry, index) => ({
      path: parentPaths[index] ?? root,
      device: entry?.dev ?? 0,
      inode: entry?.ino ?? 0,
    })),
    realParent,
    realRoot,
    backupCreated: false,
    committed: false,
  };
};

export const preflightDevEnvDestinations = async (
  consumer: string,
  writes: ReadonlyArray<DevEnvWrite>,
): Promise<PreflightResult> => {
  const root = resolve(consumer);
  const realRoot = await realpath(root);
  const checked = await Promise.all(
    writes.map(async (write) => {
      try {
        return await inspectDestination(root, realRoot, write);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return `${write.rel} could not be preflighted: ${detail}`;
      }
    }),
  );
  const destinations = checked.filter(
    (item): item is DevEnvDestination => typeof item !== 'string',
  );
  const duplicates = destinations.flatMap((destination, index) => {
    const firstIndex = destinations.findIndex(
      ({ dest }) => dest === destination.dest,
    );
    const first = destinations[firstIndex];
    return firstIndex < index && first !== undefined
      ? [
          `${destination.write.rel} resolves to the same destination as ${first.write.rel}`,
        ]
      : [];
  });
  const problems = [
    ...duplicates,
    ...checked.filter((item): item is string => typeof item === 'string'),
  ];
  return problems.length > 0
    ? { ok: false, problems }
    : {
        ok: true,
        destinations,
      };
};

export const devEnvParentProblem = async (
  destination: DevEnvDestination,
): Promise<string | null> => {
  try {
    const current = await Promise.all(
      destination.parents.map(async (parent) => ({
        expected: parent,
        actual: await devEnvStatOrNull(parent.path),
      })),
    );
    const changed = current.some(
      ({ expected, actual }) =>
        actual === null ||
        !actual.isDirectory() ||
        actual.isSymbolicLink() ||
        actual.dev !== expected.device ||
        actual.ino !== expected.inode,
    );
    const realParent = await realpath(dirname(destination.dest));
    if (
      changed ||
      realParent !== destination.realParent ||
      !containedBy(destination.realRoot, realParent)
    ) {
      return `${destination.write.rel} destination directory changed after preflight`;
    }
    return null;
  } catch {
    return `${destination.write.rel} destination directory changed after preflight`;
  }
};

export const devEnvDestinationProblems = async (
  consumer: string,
  writes: ReadonlyArray<DevEnvWrite>,
): Promise<ReadonlyArray<string>> => {
  const checked = await preflightDevEnvDestinations(consumer, writes);
  return checked.ok ? [] : checked.problems;
};
