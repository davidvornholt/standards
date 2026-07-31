import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { duplicateDestinationProblems } from './dev-env-destination-duplicates';
import { devEnvGitIgnoreProblem } from './dev-env-destination-gitignore';

export type DevEnvWrite = {
  readonly rel: string;
  readonly content: string;
};

export type DevEnvRemoval = {
  readonly rel: string;
};

export type DevEnvMutation = DevEnvWrite | DevEnvRemoval;

type DevEnvPathIdentity = {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
};

export type DevEnvDestination = {
  readonly mutation: DevEnvMutation;
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
  mutation: DevEnvMutation,
): Promise<string | DevEnvDestination> => {
  const dest = resolve(root, mutation.rel);
  if (!containedBy(root, dest)) {
    return `${mutation.rel} escapes the consumer repository`;
  }
  const paths = dirname(mutation.rel)
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
    return `${mutation.rel} has an unsafe destination directory`;
  }
  const realParent = await realpath(dirname(dest));
  if (!containedBy(realRoot, realParent)) {
    return `${mutation.rel} resolves outside the consumer repository`;
  }
  const previous = await devEnvStatOrNull(dest);
  if (previous !== null && (!previous.isFile() || previous.isSymbolicLink())) {
    return `${mutation.rel} must be absent or a regular file, not a symlink or other file type`;
  }
  const suffix = randomUUID();
  return {
    mutation,
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
  mutations: ReadonlyArray<DevEnvMutation>,
): Promise<PreflightResult> => {
  const root = resolve(consumer);
  const realRoot = await realpath(root);
  const duplicates = duplicateDestinationProblems(root, mutations);
  const checked = await Promise.all(
    mutations.map(async (mutation) => {
      try {
        return await inspectDestination(root, realRoot, mutation);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return `${mutation.rel} could not be preflighted: ${detail}`;
      }
    }),
  );
  const destinations = checked.filter(
    (item): item is DevEnvDestination => typeof item !== 'string',
  );
  const gitignoreProblems = destinations.flatMap((destination) =>
    [
      destination.mutation.rel,
      relative(root, destination.temp),
      relative(root, destination.backup),
    ].flatMap((rel) => {
      const problem = devEnvGitIgnoreProblem(consumer, rel);
      return problem === null ? [] : [problem];
    }),
  );
  const problems = [
    ...duplicates,
    ...checked.filter((item): item is string => typeof item === 'string'),
    ...gitignoreProblems,
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
      return `${destination.mutation.rel} destination directory changed after preflight`;
    }
    return null;
  } catch {
    return `${destination.mutation.rel} destination directory changed after preflight`;
  }
};

export const devEnvDestinationProblems = async (
  consumer: string,
  mutations: ReadonlyArray<DevEnvMutation>,
): Promise<ReadonlyArray<string>> => {
  const checked = await preflightDevEnvDestinations(consumer, mutations);
  return checked.ok ? [] : checked.problems;
};
