import { expect, it } from 'bun:test';
import process from 'node:process';
import { ACTUAL_UPSTREAM, runProcess } from './cli-test-support';
import {
  contract,
  DIGEST_A,
  environment,
  yamlContract,
} from './image-promotion-reference-contract-test-support';

type RegistryAccessContract = {
  readonly forbiddenDesiredStateFields: ReadonlyArray<string>;
  readonly private: {
    readonly detectorCredential: string;
    readonly detectorPermissions: Readonly<Record<string, string>>;
    readonly detectorProof: string;
    readonly hostAuthFile: string;
    readonly hostCredential: string;
    readonly hostCredentialAuthority: string;
    readonly hostCredentialScopes: ReadonlyArray<string>;
    readonly hostIdentityPolicy: string;
    readonly rotation: string;
    readonly rotationChecks: ReadonlyArray<string>;
    readonly secretRestartUnits: ReadonlyArray<string>;
  };
  readonly public: {
    readonly detectorCredential: string;
    readonly detectorProof: string;
    readonly hostAuthFile: string;
    readonly hostCredential: string;
  };
};

const registry = yamlContract<RegistryAccessContract>('registry-access');
const resolver = contract('registry-resolution', 'sh');
const prelude = `
resolve-anonymous-tag() { printf 'anonymous:%s\\n' "$ANONYMOUS_DIGEST"; }
require-exact-private-visibility() {
  test "$PROVIDER_IMAGE" = "$IMAGE_REPOSITORY"
  test "$PROVIDER_VISIBILITY" = private
  printf 'visibility:private\\n'
}
reject-anonymous-readable() {
  test "$ANONYMOUS_READABLE" = false
  printf 'anonymous-denied\\n'
}
resolve-authenticated-tag() {
  test -n "$REGISTRY_TOKEN"
  printf 'authenticated:%s\\n' "$AUTHENTICATED_DIGEST"
}
`;

const runResolver = ({
  access,
  anonymousDigest = DIGEST_A,
  anonymousReadable = 'false',
  authenticatedDigest = DIGEST_A,
  registryToken = 'masked-fixture',
  providerImage = 'ghcr.io/example/app/web',
  providerVisibility = 'private',
}: {
  readonly access: string;
  readonly anonymousDigest?: string;
  readonly anonymousReadable?: string;
  readonly authenticatedDigest?: string;
  readonly registryToken?: string;
  readonly providerImage?: string;
  readonly providerVisibility?: string;
}) =>
  runProcess(
    'bash',
    ACTUAL_UPSTREAM,
    ['-c', `${prelude}\n${resolver}`],
    environment([
      ['ANONYMOUS_DIGEST', anonymousDigest],
      ['ANONYMOUS_READABLE', anonymousReadable],
      ['AUTHENTICATED_DIGEST', authenticatedDigest],
      ['PATH', process.env.PATH],
      ['PROVIDER_IMAGE', providerImage],
      ['PROVIDER_VISIBILITY', providerVisibility],
      ['REGISTRY_ACCESS', access],
      ['REGISTRY_TOKEN', registryToken],
      ['IMAGE_REPOSITORY', 'ghcr.io/example/app/web'],
    ]),
  );

it('declares separate public and private access planes with honest PAT authority', () => {
  expect(registry.public).toEqual({
    detectorCredential: 'none',
    detectorProof: 'anonymously-readable',
    hostAuthFile: '/run/containers/auth/anonymous.json',
    hostCredential: 'none',
  });
  expect(registry.private).toEqual({
    detectorCredential: 'github-actions-token',
    detectorPermissions: { contents: 'read', packages: 'read' },
    detectorProof:
      'exact-private-visibility-then-anonymous-denied-then-authenticated-readable',
    hostAuthFile: '/run/containers/auth/ghcr-private.json',
    hostCredential: 'sops-classic-pat',
    hostCredentialAuthority: 'all-packages-readable-by-token-owner',
    hostCredentialScopes: ['read:packages'],
    hostIdentityPolicy:
      'dedicated-package-reader-or-explicit-account-wide-acceptance',
    rotation: 'replace-verify-revoke',
    rotationChecks: [
      'intended-package-readable',
      'unrelated-package-authority-reviewed',
    ],
    secretRestartUnits: ['podman-ghcr-login.service'],
  });
  expect(registry.forbiddenDesiredStateFields).toEqual([
    'credential',
    'secretPath',
    'username',
    'authFile',
  ]);
});

it('resolves public tags anonymously without touching a credential', () => {
  const result = runResolver({ access: 'public', registryToken: '' });
  expect(result).toMatchObject({
    status: 0,
    stdout: `anonymous:${DIGEST_A}\n`,
  });
});

it('requires private tags to deny anonymous access before authentication', () => {
  const resolved = runResolver({ access: 'private' });
  expect(resolved).toMatchObject({
    status: 0,
    stdout: `visibility:private\nanonymous-denied\nauthenticated:${DIGEST_A}\n`,
  });
  for (const fixture of [
    { access: 'private', anonymousReadable: 'true' },
    { access: 'private', registryToken: '' },
    { access: 'private', providerVisibility: 'public' },
    { access: 'private', providerVisibility: 'internal' },
    { access: 'private', providerImage: 'ghcr.io/example/other' },
    { access: 'unexpected' },
  ]) {
    expect(runResolver(fixture).status).not.toBe(0);
  }
});
