import { rename, rm } from 'node:fs/promises';
import {
  type DevEnvDestination,
  devEnvParentProblem,
} from './dev-env-destination';

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const requireParent = async (
  destination: DevEnvDestination,
): Promise<string | null> => devEnvParentProblem(destination);

const rollbackOne = async (
  destination: DevEnvDestination,
): Promise<ReadonlyArray<string>> => {
  const problems: Array<string> = [];
  if (destination.committed) {
    const parentProblem = await requireParent(destination);
    if (parentProblem !== null) {
      return [parentProblem];
    }
    try {
      await rm(destination.dest, { force: true });
      destination.committed = false;
    } catch (error) {
      problems.push(`${destination.write.rel}: ${message(error)}`);
    }
  }
  if (destination.backupCreated && problems.length === 0) {
    const parentProblem = await requireParent(destination);
    if (parentProblem !== null) {
      return [parentProblem];
    }
    try {
      await rename(destination.backup, destination.dest);
      destination.backupCreated = false;
    } catch (error) {
      problems.push(`${destination.write.rel}: ${message(error)}`);
    }
  }
  return problems;
};

export const rollbackDevEnvFiles = async (
  destinations: ReadonlyArray<DevEnvDestination>,
): Promise<ReadonlyArray<string>> => {
  const outcomes = await Promise.all(destinations.map(rollbackOne));
  return outcomes.flat();
};

const cleanupOne = async (
  destination: DevEnvDestination,
  preserveBackups: boolean,
): Promise<ReadonlyArray<string>> => {
  const parentProblem = await requireParent(destination);
  if (parentProblem !== null) {
    return [parentProblem];
  }
  const paths = [destination.temp];
  if (!preserveBackups) {
    paths.push(destination.backup);
  }
  const outcomes = await Promise.allSettled(
    paths.map((path) => rm(path, { force: true })),
  );
  return outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [message(outcome.reason)] : [],
  );
};

export const cleanupDevEnvArtifacts = async (
  destinations: ReadonlyArray<DevEnvDestination>,
  preserveBackups: boolean,
): Promise<ReadonlyArray<string>> => {
  const outcomes = await Promise.all(
    destinations.map((destination) => cleanupOne(destination, preserveBackups)),
  );
  return outcomes.flat();
};
