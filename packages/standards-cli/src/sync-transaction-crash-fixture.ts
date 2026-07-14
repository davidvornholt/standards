import process from 'node:process';
import { inspectRepositoryFiles, openRepositoryRoot } from './sync-filesystem';
import { applyRepositoryMutations } from './sync-mutations';
import type { FileOperation } from './sync-transaction-types';

const [rootPath, phase] = process.argv.slice(2);
if (rootPath === undefined || phase === undefined) {
  throw new Error('Crash fixture requires a root and phase');
}

const root = await openRepositoryRoot(rootPath, 'crash fixture');
const states = await inspectRepositoryFiles(root, [
  'managed/a.txt',
  'managed/b.txt',
  'managed/stale.txt',
  'new-parent/new.txt',
  'sync-standards.lock',
]);
const required = (rel: string) => {
  const state = states.get(rel);
  if (state === undefined) {
    throw new Error(`Missing crash fixture state: ${rel}`);
  }
  return state;
};
const crash = (): Promise<void> => {
  process.kill(process.pid, 'SIGKILL');
  return Promise.resolve();
};
const fixedCrashEvents: Readonly<Record<string, string>> = {
  'after-committed-dir': 'committed-dir:after:COMMITTED',
  'after-committed-file': 'committed-file:after:COMMITTED',
  'after-lock': 'install:after:sync-standards.lock',
  'after-parent-marker': 'parent-marker:after:new-parent',
  'after-parent-mkdir': 'mkdir:after:new-parent',
  'first-install': 'install:after:managed/a.txt',
};
const startsRollbackCleanup = (
  operation: FileOperation,
  rel: string,
  timing: 'after' | 'before',
): boolean =>
  (phase.startsWith('rollback-after-cleanup-unlink-') ||
    phase.startsWith('rollback-after-parent-cleanup-')) &&
  operation === 'install' &&
  timing === 'after' &&
  rel === 'managed/a.txt';

const fault = (
  operation: FileOperation,
  rel: string,
  timing: 'after' | 'before' = 'after',
): Promise<void> => {
  if (startsRollbackCleanup(operation, rel, timing)) {
    return Promise.reject(new Error('start rollback cleanup'));
  }
  const event = `${operation}:${timing}:${rel}`;
  const backupCrashPhase =
    rel === 'managed/stale.txt' &&
    timing === 'after' &&
    phase === `after-${operation}`;
  const parentCleanupCrashPhase =
    rel === 'new-parent' &&
    timing === 'after' &&
    [`committed-after-${operation}`, `rollback-after-${operation}`].includes(
      phase,
    );
  if (
    backupCrashPhase ||
    parentCleanupCrashPhase ||
    fixedCrashEvents[phase] === event
  ) {
    return crash();
  }
  if (
    ['rollback-restore-after-bind', 'rollback-restore-after-link'].includes(
      phase,
    ) &&
    event === 'install:before:managed/a.txt'
  ) {
    return Promise.reject(new Error('start rollback'));
  }
  if (
    phase === 'rollback-remove-after-bind' &&
    event === 'install:before:managed/b.txt'
  ) {
    return Promise.reject(new Error('start rollback'));
  }
  if (
    phase === 'rollback-restore-after-link' &&
    event === 'rollback-restore:after:managed/a.txt'
  ) {
    return crash();
  }
  if (
    (phase === 'rollback-remove-after-bind' &&
      event === 'rollback-remove-bind:after:managed/a.txt') ||
    (phase === 'rollback-restore-after-bind' &&
      event === 'rollback-restore-bind:after:managed/stale.txt')
  ) {
    return crash();
  }
  return Promise.resolve();
};

await applyRepositoryMutations(
  {
    deletes: [
      { before: required('managed/stale.txt'), rel: 'managed/stale.txt' },
    ],
    prunes: [],
    root,
    writes: [
      {
        before: required('managed/a.txt'),
        contents: Buffer.from('new a\n'),
        mode: required('managed/a.txt').mode,
        rel: 'managed/a.txt',
      },
      {
        before: required('managed/b.txt'),
        contents: Buffer.from('new b\n'),
        mode: required('managed/b.txt').mode,
        rel: 'managed/b.txt',
      },
      {
        before: required('new-parent/new.txt'),
        contents: Buffer.from('new nested\n'),
        mode: required('new-parent/new.txt').mode,
        rel: 'new-parent/new.txt',
      },
      {
        before: required('sync-standards.lock'),
        contents: Buffer.from('new lock\n'),
        mode: required('sync-standards.lock').mode,
        rel: 'sync-standards.lock',
      },
    ],
  },
  {
    afterCleanupArtifactUnlink: (name) =>
      [
        `after-cleanup-unlink-${name}`,
        `rollback-after-cleanup-unlink-${name}`,
      ].includes(phase)
        ? crash()
        : Promise.resolve(),
    afterCleanupParents: phase === 'during-cleanup' ? crash : undefined,
    afterCleanupRemoval: phase === 'after-cleanup-removal' ? crash : undefined,
    afterCleanupReservationPartialWrite:
      phase === 'during-cleanup-reservation-write' ? crash : undefined,
    afterCommitted: phase === 'after-committed' ? crash : undefined,
    afterJournal: phase === 'after-journal' ? crash : undefined,
    afterJournalPartialWrite:
      phase === 'during-journal-write' ? crash : undefined,
    afterJournalRename: phase === 'after-journal-rename' ? crash : undefined,
    afterOwnerFinalSync: phase === 'after-owner-final-sync' ? crash : undefined,
    afterOwnerPartialWrite: phase === 'during-owner-write' ? crash : undefined,
    afterOwnerReservationFinalSync:
      phase === 'after-owner-reservation' ? crash : undefined,
    afterReservationFinalSync:
      phase === 'after-reservation-final-sync' ? crash : undefined,
    afterReservationPartialWrite:
      phase === 'during-reservation-write' ? crash : undefined,
    afterTransactionPublicationMkdir:
      phase === 'after-transaction-publication-mkdir' ? crash : undefined,
    afterTransactionMkdir:
      phase === 'after-transaction-mkdir' ? crash : undefined,
    beforeCommitMarker: phase === 'before-lock' ? crash : undefined,
    beforeCleanupRmdir: phase === 'before-cleanup-rmdir' ? crash : undefined,
    beforeJournalRename: phase === 'before-journal-rename' ? crash : undefined,
    beforeJournalTempOpen:
      phase === 'before-journal-temp-open' ? crash : undefined,
    fault,
  },
);
