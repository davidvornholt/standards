import { afterEach, expect, it } from 'bun:test';
import { inspectRepositoryFiles } from './sync-file-inspection';
import { openRepositoryRoot } from './sync-filesystem';
import { applyRepositoryMutations } from './sync-mutations';
import {
  cleanupFixtures,
  requiredState,
  temporaryRoot,
  writeFixture,
} from './sync-mutations-test-helpers';
import type { FileOperation } from './sync-transaction-types';

afterEach(cleanupFixtures);

it('orders parent and commit durability before their decision events', async () => {
  const rootPath = temporaryRoot();
  writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const states = await inspectRepositoryFiles(root, [
    'new-parent/new.txt',
    'sync-standards.lock',
  ]);
  const events: Array<string> = [];

  await applyRepositoryMutations(
    {
      deletes: [],
      prunes: [],
      root,
      writes: [
        {
          before: requiredState(states, 'new-parent/new.txt'),
          contents: Buffer.from('new\n'),
          mode: requiredState(states, 'new-parent/new.txt').mode,
          rel: 'new-parent/new.txt',
        },
        {
          before: requiredState(states, 'sync-standards.lock'),
          contents: Buffer.from('new lock\n'),
          mode: requiredState(states, 'sync-standards.lock').mode,
          rel: 'sync-standards.lock',
        },
      ],
    },
    {
      afterJournal: () => {
        events.push('journal-directory-synced');
        return Promise.resolve();
      },
      afterJournalRename: () => {
        events.push('journal-renamed');
        return Promise.resolve();
      },
      afterCommitted: () => {
        events.push('decision-complete');
        return Promise.resolve();
      },
      beforeJournalRename: () => {
        events.push('journal-temp-synced');
        return Promise.resolve();
      },
      fault: (
        operation: FileOperation,
        rel: string,
        timing: 'after' | 'before' = 'after',
      ) => {
        events.push(`${operation}:${timing}:${rel}`);
        return Promise.resolve();
      },
    },
  );

  expect(events.indexOf('journal-temp-synced')).toBeLessThan(
    events.indexOf('journal-renamed'),
  );
  expect(events.indexOf('journal-renamed')).toBeLessThan(
    events.indexOf('journal-directory-synced'),
  );

  expect(events.indexOf('mkdir:after:new-parent')).toBeLessThan(
    events.indexOf('mkdir-fsync:after:new-parent'),
  );
  expect(events.indexOf('mkdir-fsync:after:new-parent')).toBeLessThan(
    events.indexOf('parent-marker:after:new-parent'),
  );
  expect(events.indexOf('parent-marker:after:new-parent')).toBeLessThan(
    events.indexOf('parent-marker-fsync:after:new-parent'),
  );
  expect(events.indexOf('committed-file:after:COMMITTED')).toBeLessThan(
    events.indexOf('committed-dir:after:COMMITTED'),
  );
  expect(events.indexOf('committed-dir:after:COMMITTED')).toBeLessThan(
    events.indexOf('decision-complete'),
  );
});
