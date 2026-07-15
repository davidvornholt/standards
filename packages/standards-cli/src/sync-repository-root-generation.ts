import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  identitiesMatch,
  identityOf,
  type RepositoryRoot,
} from './sync-filesystem';

export const assertRepositoryRootUnchanged = async (
  root: RepositoryRoot,
): Promise<void> => {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      root.path,
      constants.O_RDONLY + constants.O_DIRECTORY + constants.O_NOFOLLOW,
    );
  } catch (error) {
    throw new Error(`${root.label} root changed after preflight`, {
      cause: error,
    });
  }
  try {
    const current = await handle.stat({ bigint: true });
    if (
      !(
        current.isDirectory() &&
        identitiesMatch(root.identity, identityOf(current))
      )
    ) {
      throw new Error(`${root.label} root changed after preflight`);
    }
  } finally {
    await handle.close();
  }
};
