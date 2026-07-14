import type { MutationFault } from './sync-transaction-types';

export type MutationTestHooks = {
  readonly afterCleanupArtifactUnlink?: (name: string) => Promise<void>;
  readonly afterCleanupRemoval?: () => Promise<void>;
  readonly afterCleanupParents?: () => Promise<void>;
  readonly afterCleanupReservationPartialWrite?: () => Promise<void>;
  readonly afterCommitted?: () => Promise<void>;
  readonly afterCommitMarker?: () => Promise<void>;
  readonly afterJournal?: () => Promise<void>;
  readonly afterJournalPartialWrite?: () => Promise<void>;
  readonly afterJournalRename?: () => Promise<void>;
  readonly afterOwnerFinalSync?: () => Promise<void>;
  readonly afterOwnerPartialWrite?: () => Promise<void>;
  readonly afterOwnerReservationFinalSync?: () => Promise<void>;
  readonly afterReservationFinalSync?: () => Promise<void>;
  readonly afterReservationPartialWrite?: () => Promise<void>;
  readonly afterTransactionPublicationMkdir?: () => Promise<void>;
  readonly afterTransactionMkdir?: () => Promise<void>;
  readonly beforeCleanup?: () => Promise<void>;
  readonly beforeCleanupRmdir?: () => Promise<void>;
  readonly beforeCommitDecision?: () => Promise<void>;
  readonly beforeCommitMarker?: () => Promise<void>;
  readonly beforeJournalRename?: () => Promise<void>;
  readonly beforeJournalTempOpen?: () => Promise<void>;
  readonly beforeTransactionMkdir?: () => Promise<void>;
  readonly beforeMutation?: () => Promise<void>;
  readonly fault?: MutationFault;
};

export const noMutationFault: MutationFault = () => Promise.resolve();
