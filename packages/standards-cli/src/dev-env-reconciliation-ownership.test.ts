import { describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DevEnvRemoval } from './dev-env-destination';
import { DEV_ENV_GENERATED_HEADER } from './dev-env-dotenv';
import { planDevEnvRemovals } from './dev-env-reconciliation';
import { initializeDevEnvGit } from './dev-env-test-support';
import { applyDevEnvChanges } from './dev-env-transaction';

const fixture = (): { readonly consumer: string; readonly env: string } => {
  const consumer = mkdtempSync(join(tmpdir(), 'dev-env-removal-owner-'));
  initializeDevEnvGit(consumer);
  const workspace = join(consumer, 'packages/db');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'package.json'), '{}\n');
  const env = join(workspace, '.env.local');
  writeFileSync(env, `${DEV_ENV_GENERATED_HEADER}\nOLD_DB=1\n`);
  return { consumer, env };
};

const plannedRemoval = (consumer: string): DevEnvRemoval => {
  const [removal] = planDevEnvRemovals(consumer, []).removals;
  if (removal === undefined) {
    throw new Error('expected packages/db/.env.local removal');
  }
  return removal;
};

const replaceWithHandOwnedFile = (env: string): void => {
  rmSync(env);
  writeFileSync(env, 'HAND_OWNED=preserve-me\n');
};

describe('dev env removal ownership transaction', () => {
  it('refuses a hand-owned replacement installed after planning', async () => {
    const { consumer, env } = fixture();
    try {
      const removal = plannedRemoval(consumer);
      replaceWithHandOwnedFile(env);

      expect(await applyDevEnvChanges(consumer, [removal])).toEqual({
        ok: false,
        problems: ['packages/db/.env.local changed after planning'],
      });
      expect(readFileSync(env, 'utf8')).toBe('HAND_OWNED=preserve-me\n');
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it('restores a hand-owned replacement swapped after the latest check', async () => {
    const { consumer, env } = fixture();
    try {
      const removal = plannedRemoval(consumer);
      const result = await applyDevEnvChanges(consumer, [removal], {
        afterDestinationCheck: () => replaceWithHandOwnedFile(env),
      });

      expect(result).toEqual({
        ok: false,
        problems: ['packages/db/.env.local changed after preflight'],
      });
      expect(readFileSync(env, 'utf8')).toBe('HAND_OWNED=preserve-me\n');
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it('rechecks exact-header ownership on the claimed inode', async () => {
    const { consumer, env } = fixture();
    try {
      const removal = plannedRemoval(consumer);
      const result = await applyDevEnvChanges(consumer, [removal], {
        afterDestinationCheck: () => {
          writeFileSync(env, 'HAND_OWNED=same-inode\n');
        },
      });

      expect(result).toEqual({
        ok: false,
        problems: ['packages/db/.env.local changed after preflight'],
      });
      expect(readFileSync(env, 'utf8')).toBe('HAND_OWNED=same-inode\n');
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });
});
