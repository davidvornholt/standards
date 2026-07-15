import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SYNC_LOCK_FILE as CONTROL_SEAM_LOCK_FILE,
  classifyReservedSyncTarget,
} from './sync-control-seams';
import { GIT_RECOVERY_ARTIFACT_EXCLUDES } from './sync-git-exclude';
import {
  RESERVED_TRANSACTION_ARTIFACT_GRAMMAR,
  SYNC_LOCK_FILE,
} from './sync-transaction-namespace';
import type { TransactionJournal } from './sync-transaction-types';

const source = (name: string): string =>
  readFileSync(join(import.meta.dir, name), 'utf8');

it('derives the exact Git exclusion contract from the reserved grammar', () => {
  expect(GIT_RECOVERY_ARTIFACT_EXCLUDES).toEqual([
    '.standards-transaction',
    '.standards-transaction-cleanup',
    '.standards-transaction-owner-reservation',
    '.standards-transaction-reservation',
    '.standards-transaction-reservation.[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f].tmp',
    'OWNER.[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f].tmp',
    '.standards-transaction-publication-*',
    '.standards-owner-publication-*',
    '.standards-parent-*',
    '.standards-removal-*',
  ]);
  expect(
    GIT_RECOVERY_ARTIFACT_EXCLUDES.slice(
      0,
      RESERVED_TRANSACTION_ARTIFACT_GRAMMAR.fixedNames.length,
    ),
  ).toEqual([...RESERVED_TRANSACTION_ARTIFACT_GRAMMAR.fixedNames]);
  expect(
    GIT_RECOVERY_ARTIFACT_EXCLUDES.slice(
      -RESERVED_TRANSACTION_ARTIFACT_GRAMMAR.prefixFamilies.length,
    ),
  ).toEqual([...RESERVED_TRANSACTION_ARTIFACT_GRAMMAR.prefixFamilies]);
});

it('shares the lock contract across journals and control seams', () => {
  const journalLock: TransactionJournal['lockRel'] = SYNC_LOCK_FILE;
  expect(journalLock).toBe(SYNC_LOCK_FILE);
  expect(CONTROL_SEAM_LOCK_FILE).toBe(SYNC_LOCK_FILE);
  expect(classifyReservedSyncTarget(SYNC_LOCK_FILE)).toEqual({
    kind: 'CLI-owned lock',
    target: SYNC_LOCK_FILE,
  });
});

it('keeps transaction consumers free of stale namespace copies', () => {
  const lockConsumers = [
    'sync-control-seams.ts',
    'sync-transaction-build.ts',
    'sync-transaction-journal-parser.ts',
    'sync-transaction-types.ts',
  ];
  for (const consumer of lockConsumers) {
    const contents = source(consumer);
    expect(contents).toContain('SYNC_LOCK_FILE');
    expect(contents).toContain("from './sync-transaction-namespace'");
    expect(contents).not.toContain("'sync-standards.lock'");
  }
  const gitExclude = source('sync-git-exclude.ts');
  expect(gitExclude).toContain("from './sync-transaction-namespace'");
  expect(gitExclude).not.toContain('.standards-');
  expect(gitExclude).not.toContain("'OWNER'");
  const ownerReservation = source('sync-transaction-owner-reservation.ts');
  expect(ownerReservation).toContain("from './sync-transaction-namespace'");
  expect(ownerReservation).not.toContain('.standards-owner-publication-');
  const mutationHelpers = source('sync-mutations-test-helpers.ts');
  expect(mutationHelpers).toContain("from './sync-transaction-namespace'");
  expect(mutationHelpers).not.toContain('.standards-removal-');
  expect(source('sync-transaction-namespace.ts')).toContain(
    "export const SYNC_LOCK_FILE = 'sync-standards.lock'",
  );
});
