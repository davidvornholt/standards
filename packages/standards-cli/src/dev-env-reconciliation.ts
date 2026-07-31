import {
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { DevEnvRemoval, DevEnvWrite } from './dev-env-destination';
import { DEV_ENV_GENERATED_HEADER } from './dev-env-dotenv';

const WORKSPACE_GROUPS = ['apps', 'packages'] as const;

export type DevEnvRemovalPlan = {
  readonly removals: ReadonlyArray<DevEnvRemoval>;
  readonly problems: ReadonlyArray<string>;
};

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const firstLine = (content: string): string => {
  const newline = content.indexOf('\n');
  return newline === -1 ? content : content.slice(0, newline);
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
  try {
    const stats = lstatSync(envPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return { removal: null, problem: null };
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { removal: null, problem: null }
      : {
          removal: null,
          problem: `could not inspect ${envRel}: ${message(error)}`,
        };
  }
  try {
    const owned =
      firstLine(readFileSync(envPath, 'utf8')) === DEV_ENV_GENERATED_HEADER;
    return { removal: owned ? { rel: envRel } : null, problem: null };
  } catch (error) {
    return {
      removal: null,
      problem: `could not read ${envRel}: ${message(error)}`,
    };
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
