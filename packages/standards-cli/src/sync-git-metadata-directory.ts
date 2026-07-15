import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import {
  openPinnedChild,
  type PinnedDirectory,
} from './sync-directory-handles';
import { identityOf } from './sync-filesystem';

const openDirectory = async (path: string): Promise<PinnedDirectory> => {
  const handle = await open(
    path,
    constants.O_RDONLY + constants.O_DIRECTORY + constants.O_NOFOLLOW,
  );
  const info = await handle.stat({ bigint: true });
  if (!info.isDirectory()) {
    await handle.close();
    throw new Error(`Git metadata path must be a real directory: ${path}`);
  }
  return { handle, identity: identityOf(info) };
};

export const pinAbsoluteGitDirectory = async (
  path: string,
): Promise<PinnedDirectory> => {
  if (!isAbsolute(path) || normalize(path) !== path || path === '/') {
    throw new Error('Git returned an invalid common metadata directory');
  }
  const parts = path.slice(1).split('/');
  if (
    parts.some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error('Git returned an invalid common metadata directory');
  }
  let current = await openDirectory('/');
  try {
    for (const part of parts) {
      // biome-ignore lint/performance/noAwaitInLoops: every path component must be opened through its pinned parent.
      const next = await openPinnedChild(current, part);
      await current.handle.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.handle.close();
    throw error;
  }
};
