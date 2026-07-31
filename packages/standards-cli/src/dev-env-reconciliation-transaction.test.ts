import { describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DevEnvRemoval } from './dev-env-destination';
import { DEV_ENV_GENERATED_HEADER } from './dev-env-dotenv';
import { planDevEnvRemovals } from './dev-env-reconciliation';
import { initializeDevEnvGit } from './dev-env-test-support';
import { applyDevEnvChanges } from './dev-env-transaction';

const MODE_MODULUS = 0o1000;
const PRIOR_MODE = 0o640;
const generated = (value: string): string =>
  `${DEV_ENV_GENERATED_HEADER}\n${value}\n`;

const fixture = (): string => {
  const consumer = mkdtempSync(join(tmpdir(), 'dev-env-mixed-'));
  initializeDevEnvGit(consumer);
  for (const rel of ['apps/web', 'apps/api', 'packages/db']) {
    mkdirSync(join(consumer, rel), { recursive: true });
    writeFileSync(join(consumer, rel, 'package.json'), '{}\n');
  }
  return consumer;
};

const plannedRemoval = (consumer: string, rel: string): DevEnvRemoval => {
  const removal = planDevEnvRemovals(consumer, []).removals.find(
    (candidate) => candidate.rel === rel,
  );
  if (removal === undefined) {
    throw new Error(`expected ${rel} to be planned for removal`);
  }
  return removal;
};

describe('dev env mixed write and removal transaction', () => {
  it('commits writes and removals together', async () => {
    const consumer = fixture();
    try {
      const web = join(consumer, 'apps/web/.env.local');
      const db = join(consumer, 'packages/db/.env.local');
      writeFileSync(web, 'OLD_WEB=1\n');
      writeFileSync(db, generated('OLD_DB=1'));
      const removal = plannedRemoval(consumer, 'packages/db/.env.local');

      expect(
        await applyDevEnvChanges(consumer, [
          { rel: 'apps/web/.env.local', content: 'NEW_WEB=1\n' },
          removal,
        ]),
      ).toEqual({ ok: true, warnings: [] });
      expect(readFileSync(web, 'utf8')).toBe('NEW_WEB=1\n');
      expect(existsSync(db)).toBe(false);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it('rolls back prior writes and removals when a later commit fails', async () => {
    const consumer = fixture();
    try {
      const web = join(consumer, 'apps/web/.env.local');
      const db = join(consumer, 'packages/db/.env.local');
      writeFileSync(web, 'OLD_WEB=1\n');
      writeFileSync(db, generated('OLD_DB=1'));
      chmodSync(db, PRIOR_MODE);
      const removal = plannedRemoval(consumer, 'packages/db/.env.local');

      const result = await applyDevEnvChanges(
        consumer,
        [
          { rel: 'apps/web/.env.local', content: 'NEW_WEB=1\n' },
          removal,
          { rel: 'apps/api/.env.local', content: 'NEW_API=1\n' },
        ],
        {
          beforeCommit: (index) => {
            if (index === 2) {
              throw new Error('induced mixed commit failure');
            }
          },
        },
      );

      expect(result).toEqual({
        ok: false,
        problems: ['induced mixed commit failure'],
      });
      expect(readFileSync(web, 'utf8')).toBe('OLD_WEB=1\n');
      expect(readFileSync(db, 'utf8')).toBe(generated('OLD_DB=1'));
      expect(statSync(db).mode % MODE_MODULUS).toBe(PRIOR_MODE);
      expect(existsSync(join(consumer, 'apps/api/.env.local'))).toBe(false);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it('refuses a removal changed to a symlink after preflight', async () => {
    const consumer = fixture();
    try {
      const env = join(consumer, 'packages/db/.env.local');
      const target = join(consumer, 'outside.env');
      writeFileSync(env, generated('OLD_DB=1'));
      writeFileSync(target, 'OUTSIDE=1\n');
      const removal = plannedRemoval(consumer, 'packages/db/.env.local');

      const result = await applyDevEnvChanges(consumer, [removal], {
        beforeCommit: () => {
          rmSync(env);
          symlinkSync('../../outside.env', env);
        },
      });

      expect(result).toEqual({
        ok: false,
        problems: ['packages/db/.env.local changed after preflight'],
      });
      expect(readFileSync(target, 'utf8')).toBe('OUTSIDE=1\n');
      expect(readFileSync(env, 'utf8')).toBe('OUTSIDE=1\n');
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it('refuses a removal after its workspace parent identity changes', async () => {
    const consumer = fixture();
    const external = mkdtempSync(join(tmpdir(), 'dev-env-remove-external-'));
    try {
      writeFileSync(
        join(consumer, 'packages/db/.env.local'),
        generated('OLD_DB=1'),
      );
      writeFileSync(join(external, 'marker'), 'UNTOUCHED\n');
      const removal = plannedRemoval(consumer, 'packages/db/.env.local');

      const result = await applyDevEnvChanges(consumer, [removal], {
        beforeCommit: () => {
          renameSync(
            join(consumer, 'packages/db'),
            join(consumer, 'packages/db-parked'),
          );
          symlinkSync(external, join(consumer, 'packages/db'));
        },
      });

      expect(result).toEqual({
        ok: false,
        problems: [
          'packages/db/.env.local destination directory changed after preflight',
          'cleanup failed: packages/db/.env.local destination directory changed after preflight',
        ],
      });
      expect(readFileSync(join(external, 'marker'), 'utf8')).toBe(
        'UNTOUCHED\n',
      );
    } finally {
      rmSync(consumer, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });
});
