import { execFileSync } from 'node:child_process';
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
  MIXED_TEST_ACCOUNT,
  mixedSecret,
  resetRefreshMixedCloudflare,
} from './creds-plan-refresh-mixed-cloudflare-test-support';
import { renderDotenv } from './dev-env-dotenv';
import { DEV_ENV_GITIGNORE } from './dev-env-test-support';

const EXECUTABLE_MODE = 0o755;
const BAD_ACCESS_ENV = 'BAD_ACCESS_KEY_ID';
const GOOD_ACCESS_ENV = 'GOOD_ACCESS_KEY_ID';
// biome-ignore lint/style/noProcessEnv: the test restores the broker override after each fixture.
const originalBroker = process.env.STANDARDS_BROKER_FILE;
// biome-ignore lint/style/noProcessEnv: the test restores PATH after each fixture.
const originalPath = process.env.PATH;
let root = '';

export type RefreshMixedKind =
  | 'bearer-s3'
  | 'preexisting-unsafe-s3'
  | 'sibling-s3';

const hasS3Sibling = (kind: RefreshMixedKind): boolean => kind !== 'bearer-s3';

const encryptedTarget = (kind: RefreshMixedKind): string =>
  [
    ...(kind === 'bearer-s3'
      ? ['api:', '  token: ENC[AES256_GCM,data:t]']
      : []),
    'r2:',
    '  bad:',
    '    access_key_id: ENC[AES256_GCM,data:a]',
    '    secret_access_key: ENC[AES256_GCM,data:b]',
    ...(hasS3Sibling(kind)
      ? [
          '  good:',
          '    access_key_id: ENC[AES256_GCM,data:c]',
          '    secret_access_key: ENC[AES256_GCM,data:d]',
        ]
      : []),
    'sops:',
    '  mac: ENC[AES256_GCM,data:y]',
    '',
  ].join('\n');

const config = (kind: RefreshMixedKind): string =>
  [
    'apps:',
    '  web:',
    '    BAD_ACCESS_KEY_ID:',
    '      brokeredS3: ci',
    '      key: r2.bad',
    '      part: access_key_id',
    ...(hasS3Sibling(kind)
      ? [
          '    GOOD_ACCESS_KEY_ID:',
          '      brokeredS3: ci',
          '      key: r2.good',
          '      part: access_key_id',
        ]
      : []),
    '',
  ].join('\n');

const sopsScript = (kind: RefreshMixedKind): string => {
  const allowlist = JSON.stringify({
    brokeredReferences: hasS3Sibling(kind)
      ? ['ci:r2.bad', 'ci:r2.good']
      : ['ci:r2.bad'],
  });
  const initialBad =
    kind === 'preexisting-unsafe-s3' ? 'foreign-bad' : 'old-bad';
  const targetDocument = `printf '{"r2":{"bad":{"access_key_id":"%s","secret_access_key":"%s"}%s}%s}' "$(grep -q 'new-bad' "$4" && printf 'new-bad' || printf '${initialBad}')" "$(grep -q 'new-bad' "$4" && printf 'concurrent-bad' || printf 'old-secret-bad')" "$([ ${JSON.stringify(hasS3Sibling(kind))} = true ] && printf ',"good":{"access_key_id":"%s","secret_access_key":"%s"}' "$(grep -q 'new-good' "$4" && printf 'new-good' || printf 'old-good')" "$(grep -q 'new-good' "$4" && printf '${mixedSecret('good')}' || printf 'old-secret-good')" || true)" "$([ ${JSON.stringify(kind)} = 'bearer-s3' ] && printf ',"api":{"token":"%s"}' "$(grep -q 'value-api' "$4" && printf 'value-api' || printf 'old-api')" || true)"`;
  return [
    '#!/bin/sh',
    'if [ "$1" = "edit" ]; then',
    '  while ! mkdir "$2.test-lock" 2>/dev/null; do sleep 0.01; done',
    '  eval "$SOPS_EDITOR \\"$2\\""; status=$?',
    '  rmdir "$2.test-lock"; exit "$status"',
    'fi',
    'if [ "$1" = "decrypt" ] && [ "$2" = "--extract" ]; then',
    '  case "$3" in',
    `    *r2*bad*access_key_id*) grep -q "new-bad" "$6" && printf "new-bad" || printf "${initialBad}" ;;`,
    '    *r2*bad*secret_access_key*) grep -q "new-bad" "$6" && printf "concurrent-bad" || printf "old-secret-bad" ;;',
    `    *r2*good*access_key_id*) grep -q "new-good" "$6" && printf "new-good" || printf "old-good" ;;`,
    `    *r2*good*secret_access_key*) grep -q "new-good" "$6" && printf '${mixedSecret('good')}' || printf "old-secret-good" ;;`,
    '    *api*token*) grep -q "value-api" "$6" && printf "value-api" || printf "old-api" ;;',
    '    *) exit 1 ;;',
    '  esac; exit 0',
    'fi',
    'case "$4" in',
    `  "secrets/dev.yaml") printf '%s' '${allowlist}' ;;`,
    `  "secrets/ci.yaml") ${targetDocument} ;;`,
    '  *) exit 1 ;;',
    'esac',
  ].join('\n');
};

export const refreshMixedFixture = (kind: RefreshMixedKind) => {
  root = mkdtempSync(join(tmpdir(), 'creds-plan-refresh-mixed-'));
  const consumer = join(root, 'consumer');
  mkdirSync(join(consumer, 'apps/web'), { recursive: true });
  mkdirSync(join(consumer, 'config'));
  mkdirSync(join(consumer, 'secrets'));
  writeFileSync(join(consumer, 'apps/web/package.json'), '{"name":"web"}\n');
  writeFileSync(join(consumer, '.gitignore'), DEV_ENV_GITIGNORE);
  writeFileSync(join(consumer, 'config/dev.yaml'), config(kind));
  writeFileSync(
    join(consumer, 'secrets/dev.yaml'),
    'sops:\n  mac: ENC[AES256_GCM,data:y]\n',
  );
  writeFileSync(join(consumer, 'secrets/ci.yaml'), encryptedTarget(kind));
  const destination = join(consumer, 'apps/web/.env.local');
  writeFileSync(
    destination,
    renderDotenv(
      'apps.web',
      ['config/dev.yaml', 'secrets/dev.yaml'],
      hasS3Sibling(kind)
        ? {
            [BAD_ACCESS_ENV]: 'old-bad',
            [GOOD_ACCESS_ENV]: 'old-good',
          }
        : { [BAD_ACCESS_ENV]: 'old-bad' },
    ),
  );
  execFileSync('git', ['init', '-q', consumer]);
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'git@github.com:davidvornholt/example.git'],
    { cwd: consumer },
  );
  const broker = join(root, 'broker.yaml');
  writeFileSync(
    broker,
    `cloudflare:\n  - account_id: ${MIXED_TEST_ACCOUNT}\n    token: bootstrap\n`,
  );
  // biome-ignore lint/style/noProcessEnv: the broker path is isolated to this test fixture.
  process.env.STANDARDS_BROKER_FILE = broker;
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'sops'), sopsScript(kind));
  chmodSync(join(bin, 'sops'), EXECUTABLE_MODE);
  // biome-ignore lint/style/noProcessEnv: the fake sops binary is isolated to this test fixture.
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  return { consumer, destination };
};

export const cleanupRefreshMixedFixture = (): void => {
  resetRefreshMixedCloudflare();
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
  }
  root = '';
};
