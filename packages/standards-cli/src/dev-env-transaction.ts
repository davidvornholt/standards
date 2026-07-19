import { link, open, rename } from 'node:fs/promises';
import {
  type DevEnvDestination,
  type DevEnvWrite,
  devEnvParentProblem,
  devEnvStatOrNull,
  preflightDevEnvDestinations,
} from './dev-env-destination';
import {
  cleanupDevEnvArtifacts,
  rollbackDevEnvFiles,
} from './dev-env-transaction-recovery';

const OWNER_ONLY_FILE_MODE = 0o600;

export type DevEnvTransactionHooks = {
  readonly beforeStage?: (index: number) => void | Promise<void>;
  readonly beforeCommit?: (index: number) => void | Promise<void>;
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

const stage = async (destination: DevEnvDestination): Promise<void> => {
  await requireParent(destination);
  const file = await open(destination.temp, 'wx', OWNER_ONLY_FILE_MODE);
  try {
    await file.chmod(OWNER_ONLY_FILE_MODE);
    await file.writeFile(destination.write.content, 'utf8');
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
  await destinations.reduce<Promise<void>>(
    async (previous, destination, index) => {
      await previous;
      await hooks.beforeStage?.(index);
      await stage(destination);
    },
    Promise.resolve(),
  );
};

const commitOne = async (destination: DevEnvDestination): Promise<void> => {
  await requireParent(destination);
  if (!(await unchanged(destination))) {
    throw new Error(`${destination.write.rel} changed after preflight`);
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
      await commitOne(destination);
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

export const writeDevEnvFiles = async (
  consumer: string,
  writes: ReadonlyArray<DevEnvWrite>,
  hooks: DevEnvTransactionHooks = {},
): Promise<DevEnvTransactionResult> => {
  const checked = await preflightDevEnvDestinations(consumer, writes);
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
