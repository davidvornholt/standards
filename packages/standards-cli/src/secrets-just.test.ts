import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  ACTUAL_UPSTREAM,
  cleanupTmpDirs,
  mkTmp,
  type RunResult,
  runProcess,
  write,
} from './cli-test-support';

const EXECUTABLE_MODE = 0o755;
const JUSTFILE = join(ACTUAL_UPSTREAM, 'justfile');
const SECRETS_JUST = join(ACTUAL_UPSTREAM, 'secrets.just');
const failSopsFileVariable = 'FAIL_SOPS_FILE';
const pathVariable = 'PATH';
const sopsLogVariable = 'SOPS_LOG';

type SecretsFixture = {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly root: string;
  readonly sopsLog: string;
};

const createFixture = (failSopsFile?: string): SecretsFixture => {
  const basePath = process.env.PATH;
  if (basePath === undefined) {
    throw new Error('test environment must define PATH');
  }
  const root = mkTmp('secrets-just-');
  const bin = join(root, 'bin');
  const sopsLog = join(root, 'sops.log');
  mkdirSync(bin);
  write(root, 'justfile', readFileSync(JUSTFILE, 'utf8'));
  write(root, 'secrets.just', readFileSync(SECRETS_JUST, 'utf8'));
  write(
    root,
    'bin/sops',
    [
      '#!/bin/sh',
      'set -eu',
      `printf '%s\\n' "$*" >> "$SOPS_LOG"`,
      `if [ "\${FAIL_SOPS_FILE:-}" = "\${2:-}" ]; then`,
      '  exit 23',
      'fi',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'sops'), EXECUTABLE_MODE);
  return {
    environment: {
      ...process.env,
      [failSopsFileVariable]: failSopsFile,
      [pathVariable]: `${bin}:${basePath}`,
      [sopsLogVariable]: sopsLog,
    },
    root,
    sopsLog,
  };
};

const runSecrets = (
  fixture: SecretsFixture,
  ...args: ReadonlyArray<string>
): RunResult =>
  runProcess(
    'just',
    fixture.root,
    ['--color', 'never', 'secrets', ...args],
    fixture.environment,
  );

const sopsCalls = (fixture: SecretsFixture): string =>
  existsSync(fixture.sopsLog) ? readFileSync(fixture.sopsLog, 'utf8') : '';

afterEach(cleanupTmpDirs);

describe('canonical secrets Just module', () => {
  it('resolves ordinary secret and host target names', () => {
    const fixture = createFixture();
    write(fixture.root, 'infra/hosts/prod-eu-1/.keep', '');
    write(fixture.root, 'infra/hosts/prod.example/.keep', '');
    const targets = [
      ['dev', 'secrets/dev.yaml'],
      ['ci', 'secrets/ci.yaml'],
      ['pr-preview', 'secrets/pr-preview.yaml'],
      ['prod-eu-1', 'infra/hosts/prod-eu-1/secrets.yaml'],
      ['prod.example', 'infra/hosts/prod.example/secrets.yaml'],
    ] as const;

    for (const [target, expectedFile] of targets) {
      const result = runSecrets(fixture, 'updatekeys', target);
      expect(result.status).toBe(0);
      expect(sopsCalls(fixture)).toContain(`updatekeys ${expectedFile}\n`);
    }
    expect(sopsCalls(fixture)).toBe(
      targets.map(([, file]) => `updatekeys ${file}\n`).join(''),
    );
  });

  it('rejects unsafe target names before invoking SOPS', () => {
    const fixture = createFixture();
    const injectionMarker = join(fixture.root, 'injected');
    const unsafeTargets = [
      `$(touch ${injectionMarker})`,
      'name with space',
      'nested/target',
      '/tmp/absolute',
      '.',
      '..',
      '-option-like',
    ];

    for (const target of unsafeTargets) {
      const result = runSecrets(fixture, 'updatekeys', target);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        'Invalid secrets target',
      );
    }
    expect(sopsCalls(fixture)).toBe('');
    expect(existsSync(injectionMarker)).toBe(false);
  });

  it('returns nonzero when an earlier updatekeys target fails', () => {
    const fixture = createFixture('secrets/a.yaml');
    write(fixture.root, 'secrets/a.yaml', 'encrypted\n');
    write(fixture.root, 'secrets/z.yaml', 'encrypted\n');

    const result = runSecrets(fixture, 'updatekeys-all');

    expect(result.status).not.toBe(0);
    expect(sopsCalls(fixture)).toBe(
      'updatekeys secrets/a.yaml\nupdatekeys secrets/z.yaml\n',
    );
  });
});
