import { describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDevEnvFiles } from './dev-env-transaction';

const PERMISSION_BITS_MODULUS = 0o1000;
const DEFAULT_FILE_MODE = 0o644;

const buildConsumer = (): string => {
  const consumer = mkdtempSync(join(tmpdir(), 'dev-env-destination-'));
  mkdirSync(join(consumer, 'apps/web'), { recursive: true });
  mkdirSync(join(consumer, 'packages/db'), { recursive: true });
  return consumer;
};

const cleanup = (consumer: string): void =>
  rmSync(consumer, { recursive: true, force: true });

describe('dev env destination safety', () => {
  it('rejects symlinks without touching their targets', async () => {
    const consumer = buildConsumer();
    try {
      const target = join(consumer, 'README.md');
      const link = join(consumer, 'apps/web/.env.local');
      writeFileSync(target, 'TRACKED\n');
      chmodSync(target, DEFAULT_FILE_MODE);
      symlinkSync('../../README.md', link);

      const result = await writeDevEnvFiles(consumer, [
        { rel: 'apps/web/.env.local', content: 'SECRET=leak\n' },
      ]);

      expect(result.ok).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe('TRACKED\n');
      expect(statSync(target).mode % PERMISSION_BITS_MODULUS).toBe(
        DEFAULT_FILE_MODE,
      );
      expect(readFileSync(link, 'utf8')).toBe('TRACKED\n');
    } finally {
      cleanup(consumer);
    }
  });

  it('gathers every unsafe destination before staging', async () => {
    const consumer = buildConsumer();
    try {
      symlinkSync('../../README.md', join(consumer, 'apps/web/.env.local'));
      mkdirSync(join(consumer, 'packages/db/.env.local'));
      const result = await writeDevEnvFiles(consumer, [
        { rel: 'apps/web/.env.local', content: 'WEB=1\n' },
        { rel: 'packages/db/.env.local', content: 'DB=1\n' },
        { rel: '../escape/.env.local', content: 'ESCAPE=1\n' },
      ]);

      expect(result).toEqual({
        ok: false,
        problems: [
          'apps/web/.env.local must be absent or a regular file, not a symlink or other file type',
          'packages/db/.env.local must be absent or a regular file, not a symlink or other file type',
          '../escape/.env.local escapes the consumer repository',
        ],
      });
      expect(
        readdirSync(join(consumer, 'apps/web')).filter((name) =>
          name.includes('.standards-'),
        ),
      ).toEqual([]);
    } finally {
      cleanup(consumer);
    }
  });

  it('rejects different paths that resolve to one destination', async () => {
    const consumer = buildConsumer();
    try {
      const result = await writeDevEnvFiles(consumer, [
        { rel: 'apps/web/.env.local', content: 'FIRST=1\n' },
        { rel: 'apps/web/../web/.env.local', content: 'SECOND=1\n' },
      ]);

      expect(result).toEqual({
        ok: false,
        problems: [
          'apps/web/../web/.env.local resolves to the same destination as apps/web/.env.local',
        ],
      });
      expect(readdirSync(join(consumer, 'apps/web'))).toEqual([]);
    } finally {
      cleanup(consumer);
    }
  });

  it('gathers raw and normalized duplicates alongside unsafe destinations', async () => {
    const consumer = buildConsumer();
    try {
      symlinkSync('../../README.md', join(consumer, 'apps/web/.env.local'));
      const result = await writeDevEnvFiles(consumer, [
        { rel: 'apps/web/.env.local', content: 'FIRST=1\n' },
        { rel: 'apps/web/.env.local', content: 'SECOND=1\n' },
        { rel: 'apps/web/../web/.env.local', content: 'THIRD=1\n' },
      ]);

      expect(result).toEqual({
        ok: false,
        problems: [
          'apps/web/.env.local is declared more than once',
          'apps/web/../web/.env.local resolves to the same destination as apps/web/.env.local',
          'apps/web/.env.local must be absent or a regular file, not a symlink or other file type',
          'apps/web/.env.local must be absent or a regular file, not a symlink or other file type',
          'apps/web/../web/.env.local must be absent or a regular file, not a symlink or other file type',
        ],
      });
    } finally {
      cleanup(consumer);
    }
  });
});
