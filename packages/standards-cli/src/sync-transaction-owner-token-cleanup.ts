import type { PinnedDirectory } from './sync-directory-handles';
import { identitiesMatch } from './sync-filesystem';
import { bindAndRemoveEntry } from './sync-transaction-bound-remove';
import {
  findOwnerPublicationTokenEntry,
  type OwnerPublicationToken,
} from './sync-transaction-owner-reservation';

export const removeOrphanOwnerPublicationToken = async (
  root: PinnedDirectory,
  reservationId?: string,
  mutate = true,
): Promise<void> => {
  const token = await findOwnerPublicationTokenEntry(root);
  if (token === null) {
    return;
  }
  if (reservationId !== undefined && token.id !== reservationId) {
    throw new Error('Owner publication token has a different reservation');
  }
  if (!mutate) {
    throw new Error('Pending owner publication token cleanup');
  }
  await removeOwnerPublicationToken(root, token);
};

export const removeOwnerPublicationToken = async (
  root: PinnedDirectory,
  token: OwnerPublicationToken,
): Promise<void> => {
  const current = await findOwnerPublicationTokenEntry(root);
  if (
    current === null ||
    current.name !== token.name ||
    !identitiesMatch(token.identity, current.identity)
  ) {
    throw new Error('Owner publication token changed during cleanup');
  }
  await bindAndRemoveEntry({
    directory: root,
    expected: token.identity,
    kind: 'file',
    name: token.name,
  });
};
