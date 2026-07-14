import { afterEach, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { openPinnedRoot } from './sync-directory-handles';
import { openRepositoryRoot } from './sync-filesystem';
import {
  cleanupFixtures,
  temporaryRoot,
  writeFixture,
} from './sync-mutations-test-helpers';
import { bindAndRemoveEntry } from './sync-transaction-bound-remove';
import { readQuarantineRecords } from './sync-transaction-quarantine-record';

afterEach(cleanupFixtures);

const fixture = join(
  import.meta.dir,
  'sync-transaction-quarantine-crash-fixture.ts',
);

for (const phase of ['partial-write', 'before-bind'] as const) {
  it(`converges repeatedly after real termination at ${phase}`, async () => {
    const rootPath = temporaryRoot();
    writeFixture(rootPath, 'owned', 'owned\n');
    const crash = spawnSync(process.execPath, [fixture, rootPath, phase], {
      stdio: 'pipe',
    });
    expect(crash.signal).toBe('SIGKILL');
    const info = statSync(join(rootPath, 'owned'), { bigint: true });
    const root = await openRepositoryRoot(rootPath, 'consumer');
    const directory = await openPinnedRoot(root);
    try {
      const input = {
        directory,
        expected: { dev: info.dev, ino: info.ino },
        kind: 'file' as const,
        name: 'owned',
      };
      await bindAndRemoveEntry(input);
      await bindAndRemoveEntry(input);
      expect(() => statSync(join(rootPath, 'owned'))).toThrow();
      expect((await readQuarantineRecords(directory))[0]?.original).toBe(
        'owned',
      );
    } finally {
      await directory.handle.close();
    }
  });
}
