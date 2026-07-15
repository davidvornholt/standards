import {
  openPinnedChild,
  type PinnedDirectory,
  type PinnedTarget,
} from './sync-directory-handles';
import { pinTarget } from './sync-directory-traversal';
import type { RepositoryRoot } from './sync-filesystem';
import { isMissingFilesystemError } from './sync-filesystem-error';
import type { NodeIdentity } from './sync-node-identity';
import { openRemovalBindingDirectory } from './sync-transaction-quarantine-read';

export const openCreatedParent = async (
  root: RepositoryRoot,
  rel: string,
  opened: Array<PinnedDirectory>,
  expected?: NodeIdentity,
): Promise<
  | { readonly directory: null; readonly target: PinnedTarget | null }
  | { readonly directory: PinnedDirectory; readonly target: PinnedTarget }
> => {
  let target: PinnedTarget;
  try {
    target = await pinTarget({
      createParents: false,
      created: [],
      opened,
      rel,
      root,
    });
  } catch (error) {
    if (isMissingFilesystemError(error)) {
      return { directory: null, target: null };
    }
    throw error;
  }
  try {
    const directory = await openPinnedChild(target.parent, target.name);
    opened.push(directory);
    return { directory, target };
  } catch (error) {
    if (isMissingFilesystemError(error)) {
      if (expected === undefined) {
        return { directory: null, target };
      }
      const directory = await openRemovalBindingDirectory(
        target.parent,
        target.name,
        expected,
      );
      if (directory === null) {
        return { directory: null, target };
      }
      opened.push(directory);
      return { directory, target };
    }
    throw error;
  }
};
