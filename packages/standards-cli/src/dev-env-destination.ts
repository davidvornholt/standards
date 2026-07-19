import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type DevEnvWrite = {
  readonly rel: string;
  readonly content: string;
};

export type DevEnvDestination = {
  readonly write: DevEnvWrite;
  readonly dest: string;
  readonly previous: Stats | null;
  readonly temp: string;
  readonly backup: string;
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
  const parents = await Promise.all(paths.map(devEnvStatOrNull));
  if (
    parents.some(
      (entry) =>
        entry === null || !entry.isDirectory() || entry.isSymbolicLink(),
    )
  ) {
    return `${write.rel} has an unsafe destination directory`;
  }
  if (!containedBy(realRoot, await realpath(dirname(dest)))) {
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
  const duplicates = writes
    .filter(
      (write, index) =>
        writes.findIndex(({ rel }) => rel === write.rel) !== index,
    )
    .map((write) => `${write.rel} is declared more than once`);
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
  const problems = [
    ...duplicates,
    ...checked.filter((item): item is string => typeof item === 'string'),
  ];
  return problems.length > 0
    ? { ok: false, problems }
    : {
        ok: true,
        destinations: checked.filter(
          (item): item is DevEnvDestination => typeof item !== 'string',
        ),
      };
};

export const devEnvDestinationProblems = async (
  consumer: string,
  writes: ReadonlyArray<DevEnvWrite>,
): Promise<ReadonlyArray<string>> => {
  const checked = await preflightDevEnvDestinations(consumer, writes);
  return checked.ok ? [] : checked.problems;
};
