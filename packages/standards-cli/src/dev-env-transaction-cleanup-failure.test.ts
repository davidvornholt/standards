import { describe, expect, it } from 'bun:test';
import {
  chmodSync,
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

describe('dev env cleanup failures', () => {
  it('warns when artifact removal actually fails after commit', async () => {
    const consumer = mkdtempSync(join(tmpdir(), 'dev-env-cleanup-failure-'));
    const workspace = join(consumer, 'apps/web');
    const dest = join(workspace, '.env.local');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(dest, 'OLD=1\n');
    chmodSync(dest, DEFAULT_FILE_MODE);
    try {
      const result = await writeDevEnvFiles(
        consumer,
        [{ rel: 'apps/web/.env.local', content: 'NEW=1\n' }],
        {
          beforeCleanup: () => {
            const backupName = readdirSync(workspace).find((name) =>
              name.endsWith('.bak'),
            );
            expect(backupName).toBeDefined();
            const backup = join(workspace, backupName ?? 'missing-backup');
            rmSync(backup);
            mkdirSync(backup);
            writeFileSync(join(backup, 'blocker'), 'BLOCK\n');
          },
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.warnings).toHaveLength(1);
      expect(
        result.warnings[0]?.startsWith(
          'generation committed but cleanup failed:',
        ),
      ).toBe(true);
      expect(result.warnings[0]).toContain('.bak');
      expect(readFileSync(dest, 'utf8')).toBe('NEW=1\n');
      expect(statSync(dest).mode % PERMISSION_BITS_MODULUS).toBe(
        OWNER_ONLY_FILE_MODE,
      );
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });
});
