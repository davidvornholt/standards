import type { PinnedDirectory } from './sync-directory-handles';
import type { RepositoryRoot } from './sync-filesystem';
import type { TransactionReservation } from './sync-transaction-reservation';

export type PublicationRecoveryInput = {
  readonly reservation: TransactionReservation | null;
  readonly root: RepositoryRoot;
  readonly rootDirectory: PinnedDirectory;
  readonly transaction: PinnedDirectory;
};
