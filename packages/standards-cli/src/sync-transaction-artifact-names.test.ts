import { afterEach, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { inspectRepositoryFiles } from './sync-file-inspection';
import { openRepositoryRoot } from './sync-filesystem';
import { applyRepositoryMutations } from './sync-mutations';
import {
  cleanupFixtures,
  readFixture,
  requiredState,
  temporaryRoot,
  writeFixture,
} from './sync-mutations-test-helpers';
import {
  atomicRecordTemporaryName,
  isAtomicRecordTemporaryName,
  isReservedAtomicRecordTemporaryName,
  isReservedTransactionPath,
  RESERVED_TRANSACTION_ARTIFACT_GRAMMAR,
} from './sync-transaction-artifact-names';
import { buildJournal } from './sync-transaction-build';
import { parseJournal } from './sync-transaction-journal-parser';
import { recoverRepositoryTransactions } from './sync-transaction-recovery';
import { TRANSACTION_RESERVATION } from './sync-transaction-types';

const ID = '11111111-1111-4111-8111-111111111111';
const EXACT = `${TRANSACTION_RESERVATION}.${ID}.tmp`;
const LOOKALIKE = `${TRANSACTION_RESERVATION}.11111111-1111-3111-8111-111111111111.tmp`;
const OWNER_EXACT = `OWNER.${ID}.tmp`;
const PARENT_EXACT = `.standards-parent-binding-${ID}-0.${ID}.tmp`;

afterEach(cleanupFixtures);

it('shares one exact UUID-v4 grammar for reserved atomic tails', () => {
  expect(atomicRecordTemporaryName(TRANSACTION_RESERVATION, ID)).toBe(EXACT);
  expect(isAtomicRecordTemporaryName(EXACT, TRANSACTION_RESERVATION)).toBe(
    true,
  );
  expect(isReservedAtomicRecordTemporaryName(EXACT)).toBe(true);
  expect(isReservedAtomicRecordTemporaryName(OWNER_EXACT)).toBe(true);
  expect(isReservedAtomicRecordTemporaryName(PARENT_EXACT)).toBe(true);
  expect(isReservedTransactionPath(`nested/${EXACT}`)).toBe(true);
  expect(isReservedTransactionPath(`nested/${OWNER_EXACT}`)).toBe(true);
  expect(isReservedTransactionPath(`nested/${PARENT_EXACT}`)).toBe(true);
  expect(isReservedAtomicRecordTemporaryName(LOOKALIKE)).toBe(false);
  expect(isReservedTransactionPath(`nested/${LOOKALIKE}`)).toBe(false);
  expect(isReservedAtomicRecordTemporaryName(`${EXACT}.extra`)).toBe(false);
});

it('reserves only the documented fixed, prefix, and atomic artifact grammar', () => {
  expect(RESERVED_TRANSACTION_ARTIFACT_GRAMMAR).toEqual({
    atomicTails: [
      '.standards-transaction-reservation.<uuid-v4>.tmp',
      'OWNER.<uuid-v4>.tmp',
      '.standards-parent-binding-<transaction-uuid-v4>-<index>.<write-uuid-v4>.tmp',
    ],
    fixedNames: [
      '.standards-transaction',
      '.standards-transaction-cleanup',
      '.standards-transaction-owner-reservation',
      '.standards-transaction-reservation',
    ],
    prefixFamilies: [
      '.standards-transaction-publication-*',
      '.standards-owner-publication-*',
      '.standards-parent-*',
      '.standards-removal-*',
    ],
  });
  expect(isReservedTransactionPath('.standards-transaction-user')).toBe(false);
  expect(isReservedTransactionPath(EXACT)).toBe(true);
  expect(isReservedTransactionPath(OWNER_EXACT)).toBe(true);
  expect(isReservedTransactionPath(PARENT_EXACT)).toBe(true);
  for (const fixed of RESERVED_TRANSACTION_ARTIFACT_GRAMMAR.fixedNames) {
    expect(isReservedTransactionPath(fixed)).toBe(true);
  }
  for (const prefix of [
    '.standards-transaction-publication-fixture',
    '.standards-owner-publication-fixture',
    '.standards-parent-fixture',
    '.standards-removal-fixture',
  ]) {
    expect(isReservedTransactionPath(prefix)).toBe(true);
  }
});

it('rejects exact tails from build and parsed write or delete operations', async () => {
  const rootPath = temporaryRoot();
  writeFixture(rootPath, EXACT, 'actor\n');
  writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const states = await inspectRepositoryFiles(root, [
    EXACT,
    'sync-standards.lock',
  ]);
  const lockWrite = {
    before: requiredState(states, 'sync-standards.lock'),
    contents: Buffer.from('new lock\n'),
    mode: requiredState(states, 'sync-standards.lock').mode,
    rel: 'sync-standards.lock',
  };
  expect(() =>
    buildJournal({
      createdParents: [],
      deletes: [{ before: requiredState(states, EXACT), rel: EXACT }],
      id: ID,
      root,
      writes: [lockWrite],
    }),
  ).toThrow('reserved transaction path');
  const journal = buildJournal({
    createdParents: [],
    deletes: [],
    id: ID,
    root,
    writes: [lockWrite],
  });
  const [lock] = journal.operations;
  expect(() =>
    parseJournal(
      JSON.stringify({ ...journal, operations: [{ ...lock, rel: EXACT }] }),
    ),
  ).toThrow('reserved transaction path');
});

it('blocks an exact managed write and preserves a lookalike after recovery', async () => {
  const rootPath = temporaryRoot();
  writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const states = await inspectRepositoryFiles(root, [
    EXACT,
    LOOKALIKE,
    'sync-standards.lock',
  ]);
  const plan = (rel: string) => ({
    deletes: [],
    prunes: [],
    root,
    writes: [
      {
        before: requiredState(states, rel),
        contents: Buffer.from('managed\n'),
        mode: null,
        rel,
      },
      {
        before: requiredState(states, 'sync-standards.lock'),
        contents: Buffer.from('new lock\n'),
        mode: requiredState(states, 'sync-standards.lock').mode,
        rel: 'sync-standards.lock',
      },
    ],
  });
  await expect(applyRepositoryMutations(plan(EXACT))).rejects.toThrow(
    'reserved transaction path',
  );
  expect(existsSync(join(rootPath, EXACT))).toBe(false);
  await applyRepositoryMutations(plan(LOOKALIKE));
  await recoverRepositoryTransactions(root);
  expect(readFixture(rootPath, LOOKALIKE)).toBe('managed\n');
  expect(readFixture(rootPath, 'sync-standards.lock')).toBe('new lock\n');
});
