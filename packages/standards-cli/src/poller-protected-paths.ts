import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from './github-settings-parse';

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
