import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { refreshDevEnvForSopsWrites } from './dev-env-brokered-refresh';
import { initializeDevEnvGit } from './dev-env-test-support';

const EXECUTABLE_MODE = 0o755;
const originalPath = process.env.PATH;
const roots: Array<string> = [];

const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'dev-env-refresh-'));
  roots.push(root);
  const consumer = join(root, 'consumer');
  mkdirSync(consumer);
  initializeDevEnvGit(consumer);
  mkdirSync(join(consumer, 'apps/web'), { recursive: true });
  writeFileSync(join(consumer, 'apps/web/package.json'), '{"name":"web"}\n');
  mkdirSync(join(consumer, 'config'));
  writeFileSync(
    join(consumer, 'config/dev.yaml'),
    [
      'apps:',
      '  web:',
      '    S3_ACCESS_KEY_ID:',
      '      brokeredS3: r2-dev',
      '      key: r2.dev_rw',
      '      part: access_key_id',
    ].join('\n'),
  );
  mkdirSync(join(consumer, 'secrets'));
  writeFileSync(join(consumer, 'secrets/dev.yaml'), 'encrypted\n');
  writeFileSync(join(consumer, 'secrets/r2-dev.yaml'), 'encrypted\n');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const devSecrets = JSON.stringify({
    brokeredReferences: ['r2-dev:r2.dev_rw'],
    apps: { web: { AUTH_SECRET: 's' } },
  });
  const pair = JSON.stringify({
    r2: { dev_rw: { access_key_id: 'AKID', secret_access_key: 'SECRET' } },
  });
  writeFileSync(
    join(bin, 'sops'),
    [
      '#!/bin/sh',
      'case "$4" in',
      `    "secrets/dev.yaml") printf '%s' ${JSON.stringify(devSecrets)} ;;`,
      `    "secrets/r2-dev.yaml") printf '%s' ${JSON.stringify(pair)} ;;`,
      '    *) echo "unexpected file $4" >&2; exit 1 ;;',
      'esac',
    ].join('\n'),
  );
  chmodSync(join(bin, 'sops'), EXECUTABLE_MODE);
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  return consumer;
};

afterEach(() => {
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('dev env refresh after brokered SOPS writes', () => {
  it('regenerates env files when a referenced target was written', async () => {
    const consumer = fixture();
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(
        await refreshDevEnvForSopsWrites(consumer, ['secrets/r2-dev.yaml']),
      ).toBe(true);
      const generated = readFileSync(
        join(consumer, 'apps/web/.env.local'),
        'utf8',
      );
      expect(generated).toContain('AKID');
      expect(generated).toContain('AUTH_SECRET');
    } finally {
      log.mockRestore();
    }
  });

  it('leaves env files alone when the written target is not referenced', async () => {
    const consumer = fixture();
    expect(
      await refreshDevEnvForSopsWrites(consumer, ['secrets/ci.yaml']),
    ).toBe(true);
    expect(existsSync(join(consumer, 'apps/web/.env.local'))).toBe(false);
  });
});
