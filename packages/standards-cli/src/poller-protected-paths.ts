import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from './github-settings-parse';
import { changesWorkspaceQualityScripts } from './poller-protocol';
import { runGit } from './poller-workspace';

const WORKSPACE_MANIFEST = /^(?:apps|packages)\/[^/]+\/package\.json$/u;

export const lockedPathsOf = async (
  workDir: string,
): Promise<ReadonlyArray<string>> => {
  const lockPath = join(workDir, 'sync-standards.lock');
  if (!existsSync(lockPath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as unknown;
    if (!(isRecord(parsed) && isRecord(parsed.files))) {
      throw new Error(
        `${lockPath} is not a valid standards sync lock with a "files" object`,
      );
    }
    return Object.keys(parsed.files);
  } catch (error) {
    throw new Error(
      `cannot trust protected paths because ${lockPath} is unreadable or invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
};

export const changedWorkspaceQualityManifests = (
  workDir: string,
  baseSha: string,
  paths: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  paths.filter((path) => {
    if (!WORKSPACE_MANIFEST.test(path)) {
      return false;
    }
    try {
      return changesWorkspaceQualityScripts(
        path,
        runGit(['-C', workDir, 'show', `${baseSha}:${path}`], null),
        readFileSync(join(workDir, path), 'utf8'),
      );
    } catch {
      return true;
    }
  });
