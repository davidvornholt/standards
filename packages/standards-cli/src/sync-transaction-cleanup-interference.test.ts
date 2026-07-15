import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { inspectRepositoryFiles } from './sync-file-inspection';
import { openRepositoryRoot } from './sync-filesystem';
import { applyRepositoryMutations } from './sync-mutations';
import {
  cleanupFixtures,
  readFixture,
  replaceFixtureFile,
  requiredState,
  temporaryRoot,
  transactionArtifacts,
  writeFixture,
} from './sync-mutations-test-helpers';
import { recoverRepositoryTransactions } from './sync-transaction-recovery';
import {
  TRANSACTION_CLEANUP,
  TRANSACTION_DIRECTORY,
  TRANSACTION_JOURNAL,
  TRANSACTION_OWNER,
  TRANSACTION_RESERVATION,
} from './sync-transaction-types';

afterEach(cleanupFixtures);

const setup = async () => {
  const rootPath = temporaryRoot();
  writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const states = await inspectRepositoryFiles(root, ['sync-standards.lock']);
  const apply = (hooks: Parameters<typeof applyRepositoryMutations>[1]) =>
    applyRepositoryMutations(
      {
        deletes: [],
        prunes: [],
        root,
        writes: [
          {
            before: requiredState(states, 'sync-standards.lock'),
            contents: Buffer.from('new lock\n'),
            mode: requiredState(states, 'sync-standards.lock').mode,
            rel: 'sync-standards.lock',
          },
        ],
      },
      hooks,
    );
  return { apply, root, rootPath };
};

describe('transaction cleanup interference', () => {
  it('preserves a reserved-entry replacement at the cleanup boundary', async () => {
    const { apply, rootPath } = await setup();
    const moved = join(rootPath, '.moved-transaction');
    await expect(
      apply({
        afterCleanupParents: () => {
          renameSync(join(rootPath, TRANSACTION_DIRECTORY), moved);
          writeFixture(
            rootPath,
            `${TRANSACTION_DIRECTORY}/actor.txt`,
            'actor\n',
          );
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow('transaction cleanup is pending');

    expect(readFixture(rootPath, `${TRANSACTION_DIRECTORY}/actor.txt`)).toBe(
      'actor\n',
    );
    expect(existsSync(join(moved, TRANSACTION_OWNER))).toBe(true);
    expect(existsSync(join(moved, TRANSACTION_JOURNAL))).toBe(true);
  });

  it('preserves an expected-name artifact replacement', async () => {
    const { apply, rootPath } = await setup();
    const stage = join(rootPath, TRANSACTION_DIRECTORY, 'new-0');
    await expect(
      apply({
        afterCleanupParents: () => {
          replaceFixtureFile(stage, 'actor stage\n');
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow('transaction cleanup is pending');

    expect(readFixture(rootPath, `${TRANSACTION_DIRECTORY}/new-0`)).toBe(
      'actor stage\n',
    );
    expect(
      existsSync(join(rootPath, TRANSACTION_DIRECTORY, TRANSACTION_JOURNAL)),
    ).toBe(true);
  });

  it('rejects an unexpected user file before unlinking artifacts', async () => {
    const { apply, rootPath } = await setup();
    let actorName = '';
    await expect(
      apply({
        afterCleanupParents: () => {
          const owner = JSON.parse(
            readFileSync(
              join(rootPath, TRANSACTION_DIRECTORY, TRANSACTION_OWNER),
              'utf8',
            ),
          ) as { readonly id: string };
          actorName = `cleanup-${owner.id}`;
          writeFixture(
            rootPath,
            `${TRANSACTION_DIRECTORY}/${actorName}`,
            'actor\n',
          );
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow('transaction cleanup is pending');

    expect(readFixture(rootPath, `${TRANSACTION_DIRECTORY}/${actorName}`)).toBe(
      'actor\n',
    );
    expect(
      existsSync(join(rootPath, TRANSACTION_DIRECTORY, TRANSACTION_OWNER)),
    ).toBe(true);
  });
});

describe('transaction reserved-path interference', () => {
  it('never clobbers a cleanup-name directory appearing after startup', async () => {
    const { apply, root, rootPath } = await setup();
    await apply({
      afterCleanupParents: () => {
        writeFixture(rootPath, `${TRANSACTION_CLEANUP}/actor.txt`, 'actor\n');
        return Promise.resolve();
      },
    });

    expect(readFixture(rootPath, `${TRANSACTION_CLEANUP}/actor.txt`)).toBe(
      'actor\n',
    );
    expect(readFixture(rootPath, 'sync-standards.lock')).toBe('new lock\n');
    await expect(recoverRepositoryTransactions(root)).rejects.toThrow();
    expect(transactionArtifacts(rootPath)).toEqual([TRANSACTION_CLEANUP]);
  });

  it('preserves a fixed actor directory that wins after reservation', async () => {
    const { apply, rootPath } = await setup();
    await expect(
      apply({
        beforeTransactionMkdir: () => {
          writeFixture(
            rootPath,
            `${TRANSACTION_DIRECTORY}/actor.txt`,
            'actor\n',
          );
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow();

    expect(readFixture(rootPath, `${TRANSACTION_DIRECTORY}/actor.txt`)).toBe(
      'actor\n',
    );
    expect(existsSync(join(rootPath, TRANSACTION_RESERVATION))).toBe(false);
  });

  it('preserves a replacement immediately after fixed-directory creation', async () => {
    const { apply, rootPath } = await setup();
    const moved = join(rootPath, '.moved-publication');
    await expect(
      apply({
        afterTransactionMkdir: () => {
          renameSync(join(rootPath, TRANSACTION_DIRECTORY), moved);
          writeFixture(
            rootPath,
            `${TRANSACTION_DIRECTORY}/actor.txt`,
            'actor\n',
          );
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow('Could not clean failed transaction publication');

    expect(readFixture(rootPath, `${TRANSACTION_DIRECTORY}/actor.txt`)).toBe(
      'actor\n',
    );
    expect(existsSync(join(rootPath, TRANSACTION_RESERVATION))).toBe(true);
  });
});
