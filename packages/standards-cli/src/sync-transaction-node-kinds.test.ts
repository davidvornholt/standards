import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { openRepositoryRoot } from './sync-filesystem';
import {
  cleanupFixtures,
  temporaryRoot,
  transactionArtifacts,
  writeFixture,
} from './sync-mutations-test-helpers';
import { recoverRepositoryTransactions } from './sync-transaction-recovery';
import {
  TRANSACTION_DIRECTORY,
  TRANSACTION_JOURNAL,
} from './sync-transaction-types';

const fixture = join(import.meta.dir, 'sync-transaction-crash-fixture.ts');
const PARENT_BINDING = /^\.standards-parent-binding-/u;

const expectedRetainedArtifacts = () => [
  expect.stringMatching(PARENT_BINDING),
  TRANSACTION_DIRECTORY,
];

afterEach(cleanupFixtures);

type Operation = {
  readonly backup: string;
  readonly rel: string;
  readonly stage: string | null;
};

const crashFixture = (phase: string) => {
  const rootPath = temporaryRoot();
  writeFixture(rootPath, 'managed/a.txt', 'old a\n');
  writeFixture(rootPath, 'managed/b.txt', 'old b\n');
  writeFixture(rootPath, 'managed/stale.txt', 'stale\n');
  writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
  const child = spawnSync(process.execPath, [fixture, rootPath, phase], {
    stdio: 'pipe',
  });
  if (child.signal !== 'SIGKILL') {
    throw new Error(`Crash fixture did not stop at ${phase}`);
  }
  const transaction = join(rootPath, TRANSACTION_DIRECTORY);
  const journal = JSON.parse(
    readFileSync(join(transaction, TRANSACTION_JOURNAL), 'utf8'),
  ) as {
    readonly id: string;
    readonly operations: ReadonlyArray<Operation>;
  };
  return { journal, rootPath, transaction };
};

const operationFor = (
  operations: ReadonlyArray<Operation>,
  rel: string,
): Operation => {
  const operation = operations.find((candidate) => candidate.rel === rel);
  if (operation === undefined) {
    throw new Error(`Missing journal operation: ${rel}`);
  }
  return operation;
};

const replaceWithFifo = (path: string): void => {
  unlinkSync(path);
  const result = spawnSync('mkfifo', [path]);
  if (result.status !== 0) {
    throw new Error(`Could not create FIFO fixture: ${result.stderr}`);
  }
};

const recoveryFailure = async (rootPath: string): Promise<unknown> => {
  const root = await openRepositoryRoot(rootPath, 'consumer');
  try {
    await recoverRepositoryTransactions(root);
  } catch (error) {
    return error;
  }
};

const failureText = (error: unknown): string => {
  if (error instanceof AggregateError) {
    return [String(error), ...error.errors.map(failureText)].join('\n');
  }
  if (error instanceof Error && error.cause !== undefined) {
    return `${String(error)}\n${failureText(error.cause)}`;
  }
  return String(error);
};

describe('nonblocking transaction node validation', () => {
  for (const artifact of ['backup', 'stage', 'target'] as const) {
    it(`rejects a FIFO ${artifact}`, async () => {
      const { journal, rootPath, transaction } = crashFixture('first-install');
      const operation = operationFor(journal.operations, 'managed/a.txt');
      const path =
        artifact === 'target'
          ? join(rootPath, operation.rel)
          : join(
              transaction,
              artifact === 'backup'
                ? operation.backup
                : (operation.stage ?? ''),
            );
      replaceWithFifo(path);

      expect(failureText(await recoveryFailure(rootPath))).toContain(
        'Mutation target must be a regular file: managed/a.txt',
      );
      expect(transactionArtifacts(rootPath)).toEqual(
        expectedRetainedArtifacts(),
      );
    });
  }

  it('rejects a FIFO created-parent marker', async () => {
    const { journal, rootPath } = crashFixture('after-parent-marker');
    const marker = join(
      rootPath,
      'new-parent',
      `.standards-parent-${journal.id}`,
    );
    replaceWithFifo(marker);

    expect(failureText(await recoveryFailure(rootPath))).toContain(
      'Created-parent ownership marker is invalid',
    );
    expect(transactionArtifacts(rootPath)).toEqual(expectedRetainedArtifacts());
  });
});
