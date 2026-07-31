import { link, open, rename } from 'node:fs/promises';
import {
  type DevEnvDestination,
  type DevEnvMutation,
  type DevEnvRemoval,
  type DevEnvWrite,
  devEnvParentProblem,
  preflightDevEnvDestinations,
} from './dev-env-destination';
import {
  devEnvStatOrNull,
  matchesDevEnvRemoval,
} from './dev-env-reconciliation';
import {
  cleanupDevEnvArtifacts,
  restoreClaimedDevEnvRemoval,
  rollbackDevEnvFiles,
} from './dev-env-transaction-recovery';

const OWNER_ONLY_FILE_MODE = 0o600;

export type DevEnvTransactionHooks = {
  readonly beforeStage?: (index: number) => void | Promise<void>;
  readonly beforeCommit?: (index: number) => void | Promise<void>;
  readonly afterDestinationCheck?: (index: number) => void | Promise<void>;
  readonly beforeCleanup?: () => void | Promise<void>;
};

export type DevEnvTransactionResult =
  | { readonly ok: true; readonly warnings: ReadonlyArray<string> }
  | { readonly ok: false; readonly problems: ReadonlyArray<string> };

const requireParent = async (destination: DevEnvDestination): Promise<void> => {
  const problem = await devEnvParentProblem(destination);
  if (problem !== null) {
    throw new Error(problem);
  }
};

const isWrite = (mutation: DevEnvMutation): mutation is DevEnvWrite =>
  'content' in mutation;

const stage = async (destination: DevEnvDestination): Promise<void> => {
  if (!isWrite(destination.mutation)) {
    return;
  }
  await requireParent(destination);
  const file = await open(destination.temp, 'wx', OWNER_ONLY_FILE_MODE);
  try {
    await file.chmod(OWNER_ONLY_FILE_MODE);
    await file.writeFile(destination.mutation.content, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
};

const unchanged = async (destination: DevEnvDestination): Promise<boolean> => {
  const current = await devEnvStatOrNull(destination.dest);
  if (current === null || destination.previous === null) {
    return current === destination.previous;
  }
  return (
    current.isFile() &&
    !current.isSymbolicLink() &&
    current.dev === destination.previous.dev &&
    current.ino === destination.previous.ino &&
    current.mode === destination.previous.mode
  );
};

const stageAll = async (
  destinations: ReadonlyArray<DevEnvDestination>,
  hooks: DevEnvTransactionHooks,
): Promise<void> => {
  const writes = destinations.filter((destination) =>
    isWrite(destination.mutation),
  );
  await writes.reduce<Promise<void>>(async (previous, destination, index) => {
    await previous;
    await hooks.beforeStage?.(index);
    await stage(destination);
  }, Promise.resolve());
};

const commitRemoval = async (
  destination: DevEnvDestination,
  removal: DevEnvRemoval,
): Promise<void> => {
  await requireParent(destination);
  await rename(destination.dest, destination.backup);
  destination.backupCreated = true;
  if (!(await matchesDevEnvRemoval(destination.backup, removal))) {
    await restoreClaimedDevEnvRemoval(destination);
    throw new Error(`${removal.rel} changed after preflight`);
  }
  const parentProblem = await devEnvParentProblem(destination);
  const replacement = await devEnvStatOrNull(destination.dest);
  if (parentProblem !== null || replacement !== null) {
    await restoreClaimedDevEnvRemoval(destination);
    throw new Error(`${removal.rel} changed after preflight`);
  }
  destination.committed = true;
};

const commitOne = async (
  destination: DevEnvDestination,
  index: number,
  hooks: DevEnvTransactionHooks,
): Promise<void> => {
  await requireParent(destination);
  if (!(await unchanged(destination))) {
    throw new Error(`${destination.mutation.rel} changed after preflight`);
  }
  await hooks.afterDestinationCheck?.(index);
  if (!isWrite(destination.mutation)) {
    await commitRemoval(destination, destination.mutation);
    return;
  }
  if (destination.previous !== null) {
    await requireParent(destination);
    await link(destination.dest, destination.backup);
    destination.backupCreated = true;
  }
  await requireParent(destination);
  await rename(destination.temp, destination.dest);
  destination.committed = true;
};

const commitAll = async (
  destinations: ReadonlyArray<DevEnvDestination>,
  hooks: DevEnvTransactionHooks,
): Promise<void> => {
  await destinations.reduce<Promise<void>>(
    async (previous, destination, index) => {
      await previous;
      await hooks.beforeCommit?.(index);
      await commitOne(destination, index, hooks);
    },
    Promise.resolve(),
  );
};

const problemMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const recoverFailure = async (
  destinations: ReadonlyArray<DevEnvDestination>,
  error: unknown,
): Promise<DevEnvTransactionResult> => {
  const rollbackProblems = await rollbackDevEnvFiles(destinations);
  const cleanupProblems = await cleanupDevEnvArtifacts(
    destinations,
    rollbackProblems.length > 0,
  );
  return {
    ok: false,
    problems: [
      problemMessage(error),
      ...rollbackProblems.map((problem) => `rollback failed: ${problem}`),
      ...cleanupProblems.map((problem) => `cleanup failed: ${problem}`),
    ],
  };
};

export const applyDevEnvChanges = async (
  consumer: string,
  mutations: ReadonlyArray<DevEnvMutation>,
  hooks: DevEnvTransactionHooks = {},
): Promise<DevEnvTransactionResult> => {
  const checked = await preflightDevEnvDestinations(consumer, mutations);
  if (!checked.ok) {
    return checked;
  }
  try {
    await stageAll(checked.destinations, hooks);
    await commitAll(checked.destinations, hooks);
  } catch (error) {
    return recoverFailure(checked.destinations, error);
  }
  let cleanupProblems: ReadonlyArray<string>;
  try {
    await hooks.beforeCleanup?.();
    cleanupProblems = await cleanupDevEnvArtifacts(checked.destinations, false);
  } catch (error) {
    cleanupProblems = [problemMessage(error)];
  }
  return {
    ok: true,
    warnings: cleanupProblems.map(
      (problem) => `generation committed but cleanup failed: ${problem}`,
    ),
  };
};
