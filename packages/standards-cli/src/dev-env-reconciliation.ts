import {
  closeSync,
  constants,
  type Dirent,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { DevEnvRemoval, DevEnvWrite } from './dev-env-destination';
import { hasDevEnvGeneratedHeader } from './dev-env-dotenv';

const WORKSPACE_GROUPS = ['apps', 'packages'] as const;

export type DevEnvRemovalPlan = {
  readonly removals: ReadonlyArray<DevEnvRemoval>;
  readonly problems: ReadonlyArray<string>;
};

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const devEnvStatOrNull = async (path: string) => {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

type WorkspaceDiscovery = {
  readonly workspaces: ReadonlyArray<Dirent>;
  readonly problems: ReadonlyArray<string>;
};

const discoverWorkspaces = (
  consumer: string,
  group: (typeof WORKSPACE_GROUPS)[number],
): WorkspaceDiscovery => {
  const groupPath = join(consumer, group);
  try {
    const stats = lstatSync(groupPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return { workspaces: [], problems: [] };
    }
    return {
      workspaces: readdirSync(groupPath, { withFileTypes: true })
        .filter((workspace) => workspace.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name)),
      problems: [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { workspaces: [], problems: [] };
    }
    return {
      workspaces: [],
      problems: [`could not inspect ${group} workspaces: ${message(error)}`],
    };
  }
};

type RemovalInspection = {
  readonly removal: DevEnvRemoval | null;
  readonly problem: string | null;
};

const inspectRemoval = (
  consumer: string,
  envRel: string,
): RemovalInspection => {
  const envPath = join(consumer, envRel);
  let file: number | null = null;
  try {
    file = openSync(
      envPath,
      constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
    );
    const stats = fstatSync(file);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return { removal: null, problem: null };
    }
    const owned = hasDevEnvGeneratedHeader(readFileSync(file, 'utf8'));
    return {
      removal: owned
        ? {
            rel: envRel,
            identity: { device: stats.dev, inode: stats.ino },
          }
        : null,
      problem: null,
    };
  } catch (error) {
    if (
      ['ELOOP', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')
    ) {
      return { removal: null, problem: null };
    }
    return {
      removal: null,
      problem: `could not inspect ${envRel}: ${message(error)}`,
    };
  } finally {
    if (file !== null) {
      closeSync(file);
    }
  }
};

export const matchesDevEnvRemoval = async (
  path: string,
  removal: DevEnvRemoval,
): Promise<boolean> => {
  try {
    const file = await open(
      path,
      constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
    );
    try {
      const stats = await file.stat();
      return (
        stats.isFile() &&
        stats.dev === removal.identity.device &&
        stats.ino === removal.identity.inode &&
        hasDevEnvGeneratedHeader(await file.readFile('utf8'))
      );
    } finally {
      await file.close();
    }
  } catch {
    return false;
  }
};

export const planDevEnvRemovals = (
  consumer: string,
  writes: ReadonlyArray<DevEnvWrite>,
): DevEnvRemovalPlan => {
  const plannedWrites = new Set(writes.map((write) => write.rel));
  const removals: Array<DevEnvRemoval> = [];
  const problems: Array<string> = [];
  for (const group of WORKSPACE_GROUPS) {
    const discovery = discoverWorkspaces(consumer, group);
    problems.push(...discovery.problems);
    for (const workspace of discovery.workspaces) {
      const workspaceRel = `${group}/${workspace.name}`;
      const envRel = `${workspaceRel}/.env.local`;
      if (
        !plannedWrites.has(envRel) &&
        existsSync(join(consumer, workspaceRel, 'package.json'))
      ) {
        const inspected = inspectRemoval(consumer, envRel);
        if (inspected.removal !== null) {
          removals.push(inspected.removal);
        }
        if (inspected.problem !== null) {
          problems.push(inspected.problem);
        }
      }
    }
  }
  return { removals, problems };
};
