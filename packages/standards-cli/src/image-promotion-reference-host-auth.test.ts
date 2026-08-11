import { afterAll, expect, it } from 'bun:test';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  ACTUAL_UPSTREAM,
  cleanupTmpDirs,
  mkTmp,
  runProcess,
} from './cli-test-support';
import {
  contract,
  DIGEST_A,
  environment,
} from './image-promotion-reference-contract-test-support';

afterAll(cleanupTmpDirs);

const AUTH_FILE_MODE = '600';
const OCTAL_RADIX = 8;

const podmanFixture = `
podman() {
  action=$1
  shift
  case "$action" in
    login)
      test "$1" = ghcr.io
      test "$2" = --authfile
      auth_file=$3
      token=$(cat)
      test "$LOGIN_SHOULD_FAIL" != true
      printf '{"token":"%s"}\n' "$token" >"$auth_file"
      ;;
    pull)
      test "$1" = --authfile
      auth_file=$2
      test "$REGISTRY_AUTH_FILE" = "$auth_file"
      test "$3" = "$IMAGE_REFERENCE"
      if test "$auth_file" = "$PUBLIC_AUTH_FILE"; then
        test "$(cat "$auth_file")" = '{"auths":{}}'
      else
        test "$auth_file" = "$PRIVATE_AUTH_FILE"
        test "$(jq -r .token "$auth_file")" = "$ACCEPTED_TOKEN"
      fi
      printf 'pull:%s:%s\n' "$CACHE_STATE" "$auth_file"
      ;;
    *) return 2 ;;
  esac
}
`;

type AuthFixture = {
  readonly acceptedToken: string;
  readonly cacheState: 'cached' | 'uncached';
  readonly loginShouldFail?: 'false' | 'true';
  readonly privateAuthFile: string;
  readonly publicAuthFile: string;
  readonly registryAccess: 'private' | 'public';
  readonly registryTokenFile: string;
};

const runAuthContract = (
  name: 'host-registry-login' | 'host-registry-pull',
  fixture: AuthFixture,
) =>
  runProcess(
    'bash',
    ACTUAL_UPSTREAM,
    ['-c', `${podmanFixture}\n${contract(name, 'sh')}`],
    environment([
      ['ACCEPTED_TOKEN', fixture.acceptedToken],
      ['CACHE_STATE', fixture.cacheState],
      ['IMAGE_REFERENCE', `ghcr.io/example/app/web@${DIGEST_A}`],
      ['LOGIN_SHOULD_FAIL', fixture.loginShouldFail ?? 'false'],
      ['PATH', process.env.PATH],
      ['PRIVATE_AUTH_FILE', fixture.privateAuthFile],
      ['PUBLIC_AUTH_FILE', fixture.publicAuthFile],
      ['REGISTRY_ACCESS', fixture.registryAccess],
      ['REGISTRY_TOKEN_FILE', fixture.registryTokenFile],
      ['REGISTRY_USERNAME', 'package-reader'],
    ]),
  );

const setup = () => {
  const root = mkTmp('image-promotion-host-auth-');
  const authDirectory = join(root, 'run', 'containers', 'auth');
  mkdirSync(authDirectory, { recursive: true, mode: 0o700 });
  const privateAuthFile = join(authDirectory, 'ghcr-private.json');
  const publicAuthFile = join(authDirectory, 'anonymous.json');
  const registryTokenFile = join(root, 'registry-token');
  writeFileSync(publicAuthFile, '{"auths":{}}\n', { mode: 0o600 });
  return { authDirectory, privateAuthFile, publicAuthFile, registryTokenFile };
};

it('keeps cached and uncached public pulls anonymous for any private PAT', () => {
  for (const cacheState of ['cached', 'uncached'] as const) {
    for (const privateToken of ['valid-private', 'invalid-private']) {
      const paths = setup();
      writeFileSync(paths.privateAuthFile, `{"token":"${privateToken}"}\n`, {
        mode: 0o600,
      });
      writeFileSync(paths.registryTokenFile, privateToken, { mode: 0o400 });
      const result = runAuthContract('host-registry-pull', {
        acceptedToken:
          privateToken === 'valid-private' ? privateToken : 'other',
        cacheState,
        ...paths,
        registryAccess: 'public',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(paths.publicAuthFile);
    }
  }
});

it('uses only the explicit private auth file and rotates A to B before revocation', () => {
  const paths = setup();
  writeFileSync(paths.registryTokenFile, 'token-a', { mode: 0o400 });
  let fixture: AuthFixture = {
    acceptedToken: 'token-a',
    cacheState: 'uncached',
    ...paths,
    registryAccess: 'private',
  };
  expect(runAuthContract('host-registry-login', fixture).status).toBe(0);
  expect(runAuthContract('host-registry-pull', fixture).status).toBe(0);

  const replacement = `${paths.registryTokenFile}.replacement`;
  writeFileSync(replacement, 'token-b', { mode: 0o400 });
  renameSync(replacement, paths.registryTokenFile);
  fixture = { ...fixture, acceptedToken: 'token-b' };
  expect(runAuthContract('host-registry-pull', fixture).status).not.toBe(0);
  expect(runAuthContract('host-registry-login', fixture).status).toBe(0);
  expect(runAuthContract('host-registry-pull', fixture).status).toBe(0);
  expect(statSync(paths.privateAuthFile).mode.toString(OCTAL_RADIX)).toEndWith(
    AUTH_FILE_MODE,
  );
});

it('preserves the prior auth file when replacement login fails', () => {
  const paths = setup();
  writeFileSync(paths.privateAuthFile, '{"token":"token-a"}\n', {
    mode: 0o600,
  });
  writeFileSync(paths.registryTokenFile, 'token-b', { mode: 0o400 });
  const result = runAuthContract('host-registry-login', {
    acceptedToken: 'token-b',
    cacheState: 'uncached',
    loginShouldFail: 'true',
    ...paths,
    registryAccess: 'private',
  });
  expect(result.status).not.toBe(0);
  expect(readFileSync(paths.privateAuthFile, 'utf8')).toContain('token-a');
  expect(
    readdirSync(paths.authDirectory).filter((name) => name.includes('.tmp.')),
  ).toEqual([]);
});
