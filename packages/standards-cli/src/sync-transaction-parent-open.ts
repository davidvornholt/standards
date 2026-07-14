import {
  openPinnedChild,
  type PinnedDirectory,
  type PinnedTarget,
} from './sync-directory-handles';
import { pinTarget } from './sync-directory-traversal';
import type { RepositoryRoot } from './sync-filesystem';
import { openRemovalBindingDirectory } from './sync-transaction-bound-remove';

const missing = (error: unknown): boolean =>
  (error as { readonly code?: unknown }).code === 'ENOENT';

export const openCreatedParent = async (
  root: RepositoryRoot,
  rel: string,
  opened: Array<PinnedDirectory>,
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
    if (missing(error)) {
      return { directory: null, target: null };
    }
    throw error;
  }
  try {
    const directory = await openPinnedChild(target.parent, target.name);
    opened.push(directory);
    return { directory, target };
  } catch (error) {
    if (missing(error)) {
      const directory = await openRemovalBindingDirectory(
        target.parent,
        target.name,
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
