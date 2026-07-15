import { afterEach, expect, it } from 'bun:test';
import { linkSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPinnedRoot } from './sync-directory-handles';
import { openRepositoryRoot } from './sync-filesystem';
import {
  cleanupFixtures,
  readFixture,
  temporaryRoot,
} from './sync-mutations-test-helpers';
import { regularAtomicRecordIdentity } from './sync-transaction-atomic-record';
import { recoverAtomicPublicationTails } from './sync-transaction-atomic-recovery';
import { bindAndRemoveEntry } from './sync-transaction-bound-remove';
import { REMOVAL_BINDING_PREFIX } from './sync-transaction-quarantine-schema';
import { TRANSACTION_RESERVATION } from './sync-transaction-types';

const NAME = `${TRANSACTION_RESERVATION}.11111111-1111-4111-8111-111111111111.tmp`;

afterEach(cleanupFixtures);

const bindGeneration = async (
  rootPath: string,
  contents: string,
  beforeBind?: () => Promise<void>,
): Promise<void> => {
  writeFileSync(join(rootPath, NAME), contents);
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const directory = await openPinnedRoot(root);
  try {
    const identity = await regularAtomicRecordIdentity(directory, NAME);
    await bindAndRemoveEntry({
      beforeBind,
      directory,
      expected: identity,
      kind: 'file',
      name: NAME,
    });
  } finally {
    await directory.handle.close();
  }
};

const recover = async (rootPath: string): Promise<void> => {
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const directory = await openPinnedRoot(root);
  try {
    await recoverAtomicPublicationTails(directory, TRANSACTION_RESERVATION);
  } finally {
    await directory.handle.close();
  }
};

it('preserves a replacement after an earlier generation was bound', async () => {
  const rootPath = temporaryRoot();
  await bindGeneration(rootPath, 'owned\n');
  writeFileSync(join(rootPath, NAME), 'actor\n');

  await recover(rootPath);

  expect(readFixture(rootPath, NAME)).toBe('actor\n');
});

it('recovers a pending generation without confusing an older binding', async () => {
  const rootPath = temporaryRoot();
  await bindGeneration(rootPath, 'old\n');
  await expect(
    bindGeneration(rootPath, 'pending\n', () =>
      Promise.reject(new Error('stop before bind')),
    ),
  ).rejects.toThrow('stop before bind');

  await recover(rootPath);

  expect(() => readFixture(rootPath, NAME)).toThrow();
  expect(
    readdirSync(rootPath).filter((name) =>
      name.startsWith(REMOVAL_BINDING_PREFIX),
    ).length,
  ).toBeGreaterThan(0);
});

it('fails closed when one generation exists at both public and bound names', async () => {
  const rootPath = temporaryRoot();
  await bindGeneration(rootPath, 'owned\n');
  const binding = readdirSync(rootPath).find(
    (name) =>
      name.startsWith(REMOVAL_BINDING_PREFIX) && name.endsWith('.entry'),
  );
  if (binding === undefined) {
    throw new Error('fixture binding was not created');
  }
  linkSync(join(rootPath, binding), join(rootPath, NAME));
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const directory = await openPinnedRoot(root);
  try {
    await expect(
      recoverAtomicPublicationTails(directory, TRANSACTION_RESERVATION),
    ).rejects.toThrow('tail and binding both exist');
  } finally {
    await directory.handle.close();
  }

  expect(readFixture(rootPath, NAME)).toBe('owned\n');
  expect(readFixture(rootPath, binding)).toBe('owned\n');
});
