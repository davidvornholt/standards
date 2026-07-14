import { afterEach, expect, it } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPinnedRoot } from './sync-directory-handles';
import { openRepositoryRoot } from './sync-filesystem';
import { cleanupFixtures, temporaryRoot } from './sync-mutations-test-helpers';
import { recoverAtomicPublicationTails } from './sync-transaction-atomic-recovery';
import { TRANSACTION_RESERVATION } from './sync-transaction-types';

const EXACT = `${TRANSACTION_RESERVATION}.11111111-1111-4111-8111-111111111111.tmp`;
const LOOKALIKE = `${TRANSACTION_RESERVATION}.11111111-1111-3111-8111-111111111111.tmp`;

afterEach(cleanupFixtures);

it('removes only exact reserved UUID-v4 publication tails', async () => {
  const rootPath = temporaryRoot();
  writeFileSync(join(rootPath, EXACT), 'partial');
  writeFileSync(join(rootPath, LOOKALIKE), 'unrelated');
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const directory = await openPinnedRoot(root);
  try {
    await recoverAtomicPublicationTails(directory, TRANSACTION_RESERVATION);
  } finally {
    await directory.handle.close();
  }

  expect(existsSync(join(rootPath, EXACT))).toBe(false);
  expect(existsSync(join(rootPath, LOOKALIKE))).toBe(true);
});

it('reports exact reserved tails during read-only recovery', async () => {
  const rootPath = temporaryRoot();
  writeFileSync(join(rootPath, EXACT), 'partial');
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const directory = await openPinnedRoot(root);
  try {
    await expect(
      recoverAtomicPublicationTails(directory, TRANSACTION_RESERVATION, false),
    ).rejects.toThrow('Pending atomic transaction record cleanup');
  } finally {
    await directory.handle.close();
  }

  expect(existsSync(join(rootPath, EXACT))).toBe(true);
});
