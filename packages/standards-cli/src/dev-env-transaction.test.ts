import { describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDevEnvFiles } from './dev-env-transaction';

const PERMISSION_BITS_MODULUS = 0o1000;
const OWNER_ONLY_FILE_MODE = 0o600;
const DEFAULT_FILE_MODE = 0o644;
const GROUP_READABLE_FILE_MODE = 0o640;
const COMMIT_FAILURE_INDEX = 2;
const STAGING_FAILURE_INDEX = 1;

const buildConsumer = (): string => {
  const consumer = mkdtempSync(join(tmpdir(), 'dev-env-transaction-'));
  for (const workspace of ['apps/web', 'apps/api', 'packages/db']) {
    mkdirSync(join(consumer, workspace), { recursive: true });
  }
  return consumer;
};

const cleanup = (consumer: string): void =>
  rmSync(consumer, { recursive: true, force: true });

const artifacts = (consumer: string): ReadonlyArray<string> =>
  ['apps/web', 'apps/api', 'packages/db'].flatMap((workspace) =>
    readdirSync(join(consumer, workspace))
      .filter((name) => name.includes('.standards-'))
      .map((name) => `${workspace}/${name}`),
  );

describe('dev env transaction', () => {
  it('commits owner-only replacements and new files', async () => {
    const consumer = buildConsumer();
    try {
      const existing = join(consumer, 'apps/web/.env.local');
      writeFileSync(existing, 'OLD=1\n');
      chmodSync(existing, DEFAULT_FILE_MODE);

      const result = await writeDevEnvFiles(consumer, [
        { rel: 'apps/web/.env.local', content: 'NEW=1\n' },
        { rel: 'packages/db/.env.local', content: 'DB=1\n' },
      ]);

      expect(result).toEqual({ ok: true, warnings: [] });
      expect(readFileSync(existing, 'utf8')).toBe('NEW=1\n');
      expect(statSync(existing).mode % PERMISSION_BITS_MODULUS).toBe(
        OWNER_ONLY_FILE_MODE,
      );
      expect(
        statSync(join(consumer, 'packages/db/.env.local')).mode %
          PERMISSION_BITS_MODULUS,
      ).toBe(OWNER_ONLY_FILE_MODE);
      expect(artifacts(consumer)).toEqual([]);
    } finally {
      cleanup(consumer);
    }
  });

  it('leaves every old file, mode, and absence intact on commit failure', async () => {
    const consumer = buildConsumer();
    try {
      const web = join(consumer, 'apps/web/.env.local');
      const db = join(consumer, 'packages/db/.env.local');
      const api = join(consumer, 'apps/api/.env.local');
      writeFileSync(web, 'OLD_WEB=1\n');
      chmodSync(web, DEFAULT_FILE_MODE);
      writeFileSync(api, 'OLD_API=1\n');
      chmodSync(api, GROUP_READABLE_FILE_MODE);

      const result = await writeDevEnvFiles(
        consumer,
        [
          { rel: 'apps/web/.env.local', content: 'NEW_WEB=1\n' },
          { rel: 'packages/db/.env.local', content: 'NEW_DB=1\n' },
          { rel: 'apps/api/.env.local', content: 'NEW_API=1\n' },
        ],
        {
          beforeCommit: (index) => {
            if (index === COMMIT_FAILURE_INDEX) {
              throw new Error('induced commit failure');
            }
          },
        },
      );

      expect(result).toEqual({
        ok: false,
        problems: ['induced commit failure'],
      });
      expect(readFileSync(web, 'utf8')).toBe('OLD_WEB=1\n');
      expect(statSync(web).mode % PERMISSION_BITS_MODULUS).toBe(
        DEFAULT_FILE_MODE,
      );
      expect(existsSync(db)).toBe(false);
      expect(readFileSync(api, 'utf8')).toBe('OLD_API=1\n');
      expect(statSync(api).mode % PERMISSION_BITS_MODULUS).toBe(
        GROUP_READABLE_FILE_MODE,
      );
      expect(artifacts(consumer)).toEqual([]);
    } finally {
      cleanup(consumer);
    }
  });

  it('cleans staged files when staging fails', async () => {
    const consumer = buildConsumer();
    const stagedFiles: Array<string> = [];
    const stagedModes: Array<number> = [];
    try {
      const result = await writeDevEnvFiles(
        consumer,
        [
          { rel: 'apps/web/.env.local', content: 'WEB=1\n' },
          { rel: 'apps/api/.env.local', content: 'API=1\n' },
        ],
        {
          beforeStage: (index) => {
            if (index === STAGING_FAILURE_INDEX) {
              const workspace = join(consumer, 'apps/web');
              const names = readdirSync(workspace).filter((name) =>
                name.endsWith('.tmp'),
              );
              stagedFiles.push(...names);
              stagedModes.push(
                ...names.map(
                  (name) =>
                    statSync(join(workspace, name)).mode %
                    PERMISSION_BITS_MODULUS,
                ),
              );
              throw new Error('induced staging failure');
            }
          },
        },
      );

      expect(result.ok).toBe(false);
      expect(stagedFiles).toHaveLength(STAGING_FAILURE_INDEX);
      expect(stagedModes).toEqual([OWNER_ONLY_FILE_MODE]);
      expect(existsSync(join(consumer, 'apps/web/.env.local'))).toBe(false);
      expect(existsSync(join(consumer, 'apps/api/.env.local'))).toBe(false);
      expect(artifacts(consumer)).toEqual([]);
    } finally {
      cleanup(consumer);
    }
  });
});

describe('dev env transaction cleanup', () => {
  it('reports cleanup failure as a warning after a completed commit', async () => {
    const consumer = buildConsumer();
    try {
      const dest = join(consumer, 'apps/web/.env.local');
      writeFileSync(dest, 'OLD=1\n');
      chmodSync(dest, DEFAULT_FILE_MODE);

      const result = await writeDevEnvFiles(
        consumer,
        [{ rel: 'apps/web/.env.local', content: 'NEW=1\n' }],
        {
          beforeCleanup: () => {
            throw new Error('induced cleanup failure');
          },
        },
      );

      expect(result).toEqual({
        ok: true,
        warnings: [
          'generation committed but cleanup failed: induced cleanup failure',
        ],
      });
      expect(readFileSync(dest, 'utf8')).toBe('NEW=1\n');
      expect(statSync(dest).mode % PERMISSION_BITS_MODULUS).toBe(
        OWNER_ONLY_FILE_MODE,
      );
    } finally {
      cleanup(consumer);
    }
  });
});
