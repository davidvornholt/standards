import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
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
const UNREADABLE_MODE = 0o000;
const originalPath = process.env.PATH;
const roots: Array<string> = [];

const fixture = () => {
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
  const sopsMarker = join(root, 'sops-called');
  writeFileSync(
    join(bin, 'sops'),
    [
      '#!/bin/sh',
      `printf called > ${JSON.stringify(sopsMarker)}`,
      'case "$4" in',
      `    "secrets/dev.yaml") printf '%s' ${JSON.stringify(devSecrets)} ;;`,
      `    "secrets/r2-dev.yaml") printf '%s' ${JSON.stringify(pair)} ;;`,
      '    *) echo "unexpected file $4" >&2; exit 1 ;;',
      'esac',
    ].join('\n'),
  );
  chmodSync(join(bin, 'sops'), EXECUTABLE_MODE);
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  return {
    consumer,
    destination: join(consumer, 'apps/web/.env.local'),
    sopsMarker,
  };
};
type Fixture = ReturnType<typeof fixture>;

const refreshWithExistingEnv = async (
  setup: Fixture,
  expectedProblem: string,
) => {
  writeFileSync(setup.destination, 'S3_ACCESS_KEY_ID=REVOKED\n');
  const error = spyOn(console, 'error').mockImplementation(() => undefined);
  const result = await refreshDevEnvForSopsWrites(setup.consumer, [
    'secrets/r2-dev.yaml',
  ]);
  const reported = error.mock.calls.flat().join('\n');
  return {
    result,
    reportsProblem: reported.includes(expectedProblem),
    reportsRemediation:
      reported.includes(
        'credential changes were written, but generated .env.local files were not updated',
      ) && reported.includes('run `bun standards dev-env`'),
    content: readFileSync(setup.destination, 'utf8'),
    sopsCalled: existsSync(setup.sopsMarker),
  };
};

const FAILED_REFRESH = {
  result: false,
  reportsProblem: true,
  reportsRemediation: true,
  content: 'S3_ACCESS_KEY_ID=REVOKED\n',
  sopsCalled: false,
} as const;

afterEach(() => {
  mock.restore();
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('dev env refresh after brokered SOPS writes', () => {
  it('regenerates env files when a referenced target was written', async () => {
    const setup = fixture();
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(
        await refreshDevEnvForSopsWrites(setup.consumer, [
          'secrets/r2-dev.yaml',
        ]),
      ).toBe(true);
      const generated = readFileSync(setup.destination, 'utf8');
      expect(generated).toContain('AKID');
      expect(generated).toContain('AUTH_SECRET');
    } finally {
      log.mockRestore();
    }
  });

  it('leaves env files alone when the written target is not referenced', async () => {
    const setup = fixture();
    writeFileSync(setup.destination, 'UNCHANGED=true\n');
    expect(
      await refreshDevEnvForSopsWrites(setup.consumer, ['secrets/ci.yaml']),
    ).toBe(true);
    expect(readFileSync(setup.destination, 'utf8')).toBe('UNCHANGED=true\n');
    expect(existsSync(setup.sopsMarker)).toBe(false);
  });

  it('rejects a malformed reference before decrypting or accepting an existing env', async () => {
    const setup = fixture();
    writeFileSync(
      join(setup.consumer, 'config/dev.yaml'),
      [
        'apps:',
        '  web:',
        '    S3_ACCESS_KEY_ID:',
        '      brokeredS3: r2-dev',
        '      key: r2.dev_rw',
        '      part: access_key_id',
        '      unknown: true',
      ].join('\n'),
    );

    expect(
      await refreshWithExistingEnv(
        setup,
        'brokered S3 pair reference has unknown property "unknown"',
      ),
    ).toEqual(FAILED_REFRESH);
  });

  it.each([
    ['invalid YAML', 'apps: [unterminated\n', EXECUTABLE_MODE],
    ['an unreadable file', 'apps: {}\n', UNREADABLE_MODE],
  ] as const)('rejects %s before decrypting or accepting an existing env', async (_, content, mode) => {
    const setup = fixture();
    const local = join(setup.consumer, 'config/dev.local.yaml');
    writeFileSync(local, content);
    chmodSync(local, mode);

    expect(
      await refreshWithExistingEnv(
        setup,
        mode === UNREADABLE_MODE
          ? 'could not read config/dev.local.yaml'
          : 'config/dev.local.yaml must contain valid YAML',
      ),
    ).toEqual(FAILED_REFRESH);
  });

  it('rejects the encrypted allowlist key in a plain layer during discovery', async () => {
    const setup = fixture();
    writeFileSync(
      join(setup.consumer, 'config/dev.local.yaml'),
      'brokeredReferences:\n  - r2-dev:r2.dev_rw\n',
    );

    expect(
      await refreshWithExistingEnv(
        setup,
        'reserved top-level key "brokeredReferences" belongs only in the SOPS-encrypted secrets/dev.yaml layer',
      ),
    ).toEqual(FAILED_REFRESH);
  });
});
