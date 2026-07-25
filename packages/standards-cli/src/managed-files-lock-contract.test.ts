// `sync-standards.lock` is persisted consumer state at a durable boundary: it
// is written by one CLI version and read by later ones. These digests are
// therefore computed here from first principles rather than from the engine, so
// a change to how the engine hashes an entry fails instead of agreeing with
// itself.

import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { cleanupTmpDirs } from './cli-test-support';
import {
  buildUpstream,
  engineFor,
  LINK,
  readLock,
  TARGET,
  writeLockFiles,
} from './managed-files-symlink-test-support';

const { initConsumer, run } = engineFor({ ...process.env });

const NUL = String.fromCharCode(0);
const HEX_DIGEST = /^[0-9a-f]{64}$/u;

const digest = (input: Buffer | string): string =>
  createHash('sha256')
    .update(typeof input === 'string' ? Buffer.from(input) : input)
    .digest('hex');

afterEach(cleanupTmpDirs);

describe('lock digest contract', () => {
  it('accepts a lock whose file entries are plain content hashes', () => {
    const { consumer } = initConsumer(buildUpstream());
    const handWritten = Object.fromEntries(
      Object.keys(readLock(consumer)).map((rel) => [
        rel,
        rel === LINK
          ? digest(`${NUL}standards-symlink${NUL}${TARGET}`)
          : digest(readFileSync(join(consumer, rel))),
      ]),
    );

    writeLockFiles(consumer, handWritten);
    const check = run(consumer, ['check', '--dir', consumer]);

    // A consumer's existing lock, written before symlinks were managed, must
    // keep validating: no marker or envelope was added to the file branch.
    expect(check.stderr).not.toContain('drifted');
    expect(check.stdout).toContain('match the last synced state');
  });

  it('records the link as a digest, not as its target string', () => {
    const { consumer } = initConsumer(buildUpstream());

    const entry = readLock(consumer)[LINK];

    expect(entry).toMatch(HEX_DIGEST);
    expect(entry).not.toContain(TARGET);
  });
});
