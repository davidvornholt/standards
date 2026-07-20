import { describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDevEnvFiles } from './dev-env-transaction';

type SwappedParent = {
  readonly external: string;
  readonly restore: () => void;
};

const buildConsumer = (): string => {
  const consumer = mkdtempSync(join(tmpdir(), 'dev-env-parent-race-'));
  mkdirSync(join(consumer, 'apps/web'), { recursive: true });
  return consumer;
};

const swapWorkspaceParent = (consumer: string): SwappedParent => {
  const external = mkdtempSync(join(tmpdir(), 'dev-env-external-'));
  const workspace = join(consumer, 'apps/web');
  const parked = join(consumer, 'apps/web-parked');
  writeFileSync(join(external, 'marker'), 'UNTOUCHED\n');
  renameSync(workspace, parked);
  symlinkSync(external, workspace);
  return {
    external,
    restore: () => {
      unlinkSync(workspace);
      renameSync(parked, workspace);
      rmSync(external, { recursive: true, force: true });
    },
  };
};

const readExternal = (external: string) => ({
  entries: readdirSync(external),
  marker: readFileSync(join(external, 'marker'), 'utf8'),
});

describe('dev env parent identity', () => {
  it('detects a parent swap after the staging hook without external writes', async () => {
    const consumer = buildConsumer();
    const swaps: Array<SwappedParent> = [];
    let external = '';
    try {
      const result = await writeDevEnvFiles(
        consumer,
        [{ rel: 'apps/web/.env.local', content: 'SECRET=1\n' }],
        {
          beforeStage: () => {
            const swapped = swapWorkspaceParent(consumer);
            swaps.push(swapped);
            ({ external } = swapped);
          },
        },
      );

      expect(result).toEqual({
        ok: false,
        problems: [
          'apps/web/.env.local destination directory changed after preflight',
          'cleanup failed: apps/web/.env.local destination directory changed after preflight',
        ],
      });
      expect(readExternal(external)).toEqual({
        entries: ['marker'],
        marker: 'UNTOUCHED\n',
      });
    } finally {
      swaps[0]?.restore();
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it('detects a parent swap after staging and before commit', async () => {
    const consumer = buildConsumer();
    const swaps: Array<SwappedParent> = [];
    let external = '';
    try {
      const result = await writeDevEnvFiles(
        consumer,
        [{ rel: 'apps/web/.env.local', content: 'SECRET=1\n' }],
        {
          beforeCommit: () => {
            const swapped = swapWorkspaceParent(consumer);
            swaps.push(swapped);
            ({ external } = swapped);
          },
        },
      );

      expect(result).toEqual({
        ok: false,
        problems: [
          'apps/web/.env.local destination directory changed after preflight',
          'cleanup failed: apps/web/.env.local destination directory changed after preflight',
        ],
      });
      expect(readExternal(external)).toEqual({
        entries: ['marker'],
        marker: 'UNTOUCHED\n',
      });
    } finally {
      swaps[0]?.restore();
      rmSync(consumer, { recursive: true, force: true });
    }
  });
});
