import { link, open, rename, rm } from 'node:fs/promises';
import {
  type DevEnvDestination,
  type DevEnvWrite,
  devEnvStatOrNull,
  preflightDevEnvDestinations,
} from './dev-env-destination';

const OWNER_ONLY_FILE_MODE = 0o600;

export type DevEnvTransactionHooks = {
  readonly beforeStage?: (index: number) => void | Promise<void>;
  readonly beforeCommit?: (index: number) => void | Promise<void>;
};

export type DevEnvTransactionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly problems: ReadonlyArray<string> };

const stage = async (destination: DevEnvDestination): Promise<void> => {
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

const rollbackOne = async (destination: DevEnvDestination): Promise<void> => {
  if (destination.committed) {
    await rm(destination.dest, { force: true });
  }
  if (destination.backupCreated) {
    await rename(destination.backup, destination.dest);
  }
};

const rollback = async (
  destinations: ReadonlyArray<DevEnvDestination>,
): Promise<void> => {
  const outcomes = await Promise.allSettled(
    destinations.map((destination) => rollbackOne(destination)),
  );
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'could not restore every destination');
  }
};

const cleanup = async (
  destinations: ReadonlyArray<DevEnvDestination>,
): Promise<void> => {
  await Promise.all(
    destinations.flatMap((destination) => [
      rm(destination.temp, { force: true }),
      rm(destination.backup, { force: true }),
    ]),
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
  if (!(await unchanged(destination))) {
    throw new Error(`${destination.write.rel} changed after preflight`);
  }
  if (destination.previous !== null) {
    await link(destination.dest, destination.backup);
    destination.backupCreated = true;
  }
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
  try {
    await rollback(destinations);
    await cleanup(destinations);
    return { ok: false, problems: [problemMessage(error)] };
  } catch (rollbackError) {
    return {
      ok: false,
      problems: [
        problemMessage(error),
        `rollback failed: ${problemMessage(rollbackError)}`,
      ],
    };
  }
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
  try {
    await cleanup(checked.destinations);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      problems: [
        `generation committed but temporary-file cleanup failed: ${problemMessage(
          error,
        )}`,
      ],
    };
  }
};
