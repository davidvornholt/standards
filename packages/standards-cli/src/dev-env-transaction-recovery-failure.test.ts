import { describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDevEnvFiles } from './dev-env-transaction';

const PERMISSION_BITS_MODULUS = 0o1000;
const PRIOR_MODE = 0o640;

const buildConsumer = (): string => {
  const consumer = mkdtempSync(join(tmpdir(), 'dev-env-recovery-failure-'));
  mkdirSync(join(consumer, 'apps/web'), { recursive: true });
  mkdirSync(join(consumer, 'packages/db'), { recursive: true });
  const web = join(consumer, 'apps/web/.env.local');
  writeFileSync(web, 'OLD=1\n');
  chmodSync(web, PRIOR_MODE);
  return consumer;
};

const backupsIn = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory)
    .filter((name) => name.endsWith('.bak'))
    .map((name) => join(directory, name));

const writes = [
  { rel: 'apps/web/.env.local', content: 'NEW=1\n' },
  { rel: 'packages/db/.env.local', content: 'DB=1\n' },
] as const;

describe('dev env recovery failures', () => {
  it('reports a rollback remove failure and preserves the old backup', async () => {
    const consumer = buildConsumer();
    const web = join(consumer, 'apps/web/.env.local');
    try {
      const result = await writeDevEnvFiles(consumer, writes, {
        beforeCommit: (index) => {
          if (index === 1) {
            rmSync(web);
            mkdirSync(web);
            writeFileSync(join(web, 'blocker'), 'BLOCK\n');
            throw new Error('induced commit failure');
          }
        },
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.problems[0]).toBe('induced commit failure');
      expect(result.problems[1]?.startsWith('rollback failed:')).toBe(true);
      expect(
        result.problems.some((problem) =>
          problem.startsWith('cleanup failed:'),
        ),
      ).toBe(false);
      const backups = backupsIn(join(consumer, 'apps/web'));
      expect(backups).toHaveLength(1);
      const backup = backups[0] ?? 'missing-backup';
      expect(readFileSync(backup, 'utf8')).toBe('OLD=1\n');
      expect(statSync(backup).mode % PERMISSION_BITS_MODULUS).toBe(PRIOR_MODE);
      expect(
        readdirSync(join(consumer, 'packages/db')).filter((name) =>
          name.endsWith('.tmp'),
        ),
      ).toEqual([]);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it('separates rollback and cleanup failures after a parent swap', async () => {
    const consumer = buildConsumer();
    const parked = join(consumer, 'apps/web-parked');
    const external = mkdtempSync(join(tmpdir(), 'dev-env-recovery-external-'));
    writeFileSync(join(external, 'marker'), 'UNTOUCHED\n');
    try {
      const result = await writeDevEnvFiles(consumer, writes, {
        beforeCommit: (index) => {
          if (index === 1) {
            renameSync(join(consumer, 'apps/web'), parked);
            symlinkSync(external, join(consumer, 'apps/web'));
            throw new Error('induced commit failure');
          }
        },
      });

      expect(result).toEqual({
        ok: false,
        problems: [
          'induced commit failure',
          'rollback failed: apps/web/.env.local destination directory changed after preflight',
          'cleanup failed: apps/web/.env.local destination directory changed after preflight',
        ],
      });
      const backups = backupsIn(parked);
      expect(backups).toHaveLength(1);
      expect(readFileSync(backups[0] ?? 'missing-backup', 'utf8')).toBe(
        'OLD=1\n',
      );
      expect(readdirSync(external)).toEqual(['marker']);
      expect(readFileSync(join(external, 'marker'), 'utf8')).toBe(
        'UNTOUCHED\n',
      );
    } finally {
      rmSync(consumer, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });
});
