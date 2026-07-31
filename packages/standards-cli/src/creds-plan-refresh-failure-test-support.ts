import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import {
  resetRefreshFailureCloudflare,
  TEST_ACCOUNT,
} from './creds-plan-refresh-failure-cloudflare-test-support';
import { DEV_ENV_GITIGNORE } from './dev-env-test-support';

const EXECUTABLE_MODE = 0o755;
const ACCESS_KEY_FIELD = 'access_key_id';
const SECRET_KEY_FIELD = 'secret_access_key';
// biome-ignore lint/style/noProcessEnv: the test restores the broker override after each fixture.
const originalBroker = process.env.STANDARDS_BROKER_FILE;
// biome-ignore lint/style/noProcessEnv: the test restores PATH after each fixture.
const originalPath = process.env.PATH;
let root = '';

const encryptedPair =
  'r2:\n  pair:\n    access_key_id: ENC[AES256_GCM,data:a]\n    secret_access_key: ENC[AES256_GCM,data:b]\nsops:\n  mac: ENC[AES256_GCM,data:y]\n';

const secretOf = (target: string): string =>
  createHash('sha256').update(`value-${target}`).digest('hex');

const sopsScript = (
  targets: ReadonlyArray<string>,
  mismatchedSecretTarget: string | null,
): string => {
  const devSecrets = JSON.stringify({
    brokeredReferences: targets.map((target) => `${target}:r2.pair`),
  });
  const documents = targets.flatMap((target) => [
    `    "secrets/${target}.yaml")`,
    `      if grep -q "new${target}" "$4"; then`,
    `        printf '%s' '${JSON.stringify({
      r2: {
        pair: {
          [ACCESS_KEY_FIELD]: `new${target}`,
          [SECRET_KEY_FIELD]:
            target === mismatchedSecretTarget
              ? `concurrent-secret-${target}`
              : secretOf(target),
        },
      },
    })}'`,
    '      else',
    `        printf '%s' '${JSON.stringify({
      r2: {
        pair: {
          [ACCESS_KEY_FIELD]: `old${target}`,
          [SECRET_KEY_FIELD]: `old-secret-${target}`,
        },
      },
    })}'`,
    '      fi ;;',
  ]);
  const extracts = targets.flatMap((target) => [
    `    "secrets/${target}.yaml")`,
    `      if grep -q "new${target}" "$6"; then`,
    `        case "$3" in *access_key_id*) printf 'new${target}' ;; *) printf '${
      target === mismatchedSecretTarget
        ? `concurrent-secret-${target}`
        : secretOf(target)
    }' ;; esac`,
    `      else printf 'old${target}'; fi ;;`,
  ]);
  return [
    '#!/bin/sh',
    'if [ "$1" = "edit" ]; then eval "$SOPS_EDITOR \\"$2\\""; exit $?; fi',
    'if [ "$1" = "decrypt" ]; then',
    '  case "$6" in',
    ...extracts,
    '    *) exit 1 ;;',
    '  esac',
    '  exit 0',
    'fi',
    'case "$4" in',
    `    "secrets/dev.yaml") printf '%s' '${devSecrets}' ;;`,
    ...documents,
    '    *) exit 1 ;;',
    'esac',
  ].join('\n');
};

export const refreshFailureFixture = (
  targets: ReadonlyArray<string>,
  options: { readonly mismatchedSecretTarget?: string } = {},
): { readonly consumer: string; readonly destination: string } => {
  root = mkdtempSync(join(tmpdir(), 'creds-plan-refresh-failure-'));
  const consumer = join(root, 'consumer');
  mkdirSync(join(consumer, 'apps/web'), { recursive: true });
  mkdirSync(join(consumer, 'config'));
  mkdirSync(join(consumer, 'secrets'));
  writeFileSync(join(consumer, 'apps/web/package.json'), '{"name":"web"}\n');
  writeFileSync(join(consumer, '.gitignore'), DEV_ENV_GITIGNORE);
  writeFileSync(
    join(consumer, 'config/dev.yaml'),
    [
      'apps:',
      '  web:',
      ...targets.flatMap((target) => [
        `    ${target.toUpperCase()}_ACCESS_KEY_ID:`,
        `      brokeredS3: ${target}`,
        '      key: r2.pair',
        '      part: access_key_id',
      ]),
    ].join('\n'),
  );
  writeFileSync(
    join(consumer, 'secrets/dev.yaml'),
    'brokeredReferences: ENC[AES256_GCM,data:x]\nsops:\n  mac: ENC[AES256_GCM,data:y]\n',
  );
  for (const target of targets) {
    writeFileSync(join(consumer, `secrets/${target}.yaml`), encryptedPair);
  }
  execFileSync('git', ['init', '-q', consumer]);
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'git@github.com:davidvornholt/example.git'],
    { cwd: consumer },
  );
  const broker = join(root, 'broker.yaml');
  writeFileSync(
    broker,
    `cloudflare:\n  - account_id: ${TEST_ACCOUNT}\n    token: bootstrap\n`,
  );
  // biome-ignore lint/style/noProcessEnv: the broker path is isolated to this test fixture.
  process.env.STANDARDS_BROKER_FILE = broker;
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const sops = join(bin, 'sops');
  writeFileSync(
    sops,
    sopsScript(targets, options.mismatchedSecretTarget ?? null),
  );
  chmodSync(sops, EXECUTABLE_MODE);
  // biome-ignore lint/style/noProcessEnv: the fake sops binary is isolated to this test fixture.
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  writeFileSync(join(consumer, 'apps/web/.env.local'), 'STALE=true\n');
  return { consumer, destination: join(consumer, 'apps/web/.env.local') };
};

export const cleanupRefreshFailureFixture = (): void => {
  resetRefreshFailureCloudflare();
  // biome-ignore lint/style/noProcessEnv: the test restores PATH after each fixture.
  process.env.PATH = originalPath;
  if (originalBroker === undefined) {
    // biome-ignore lint/style/noProcessEnv: the test restores the broker override after each fixture.
    delete process.env.STANDARDS_BROKER_FILE;
  } else {
    // biome-ignore lint/style/noProcessEnv: the test restores the broker override after each fixture.
    process.env.STANDARDS_BROKER_FILE = originalBroker;
  }
  if (root.length > 0) {
    rmSync(root, { recursive: true, force: true });
    root = '';
  }
};
