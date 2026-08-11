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
    readonly hostCredentialScope: string;
    readonly rotation: string;
  };
  readonly public: {
    readonly detectorCredential: string;
    readonly detectorProof: string;
    readonly hostCredential: string;
  };
};

const registry = yamlContract<RegistryAccessContract>('registry-access');
const resolver = contract('registry-resolution', 'sh');
const prelude = `
resolve-anonymous-tag() { printf 'anonymous:%s\\n' "$ANONYMOUS_DIGEST"; }
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
}: {
  readonly access: string;
  readonly anonymousDigest?: string;
  readonly anonymousReadable?: string;
  readonly authenticatedDigest?: string;
  readonly registryToken?: string;
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
      ['REGISTRY_ACCESS', access],
      ['REGISTRY_TOKEN', registryToken],
    ]),
  );

it('declares separate least-privilege public and private access planes', () => {
  expect(registry.public).toEqual({
    detectorCredential: 'none',
    detectorProof: 'anonymously-readable',
    hostCredential: 'none',
  });
  expect(registry.private).toEqual({
    detectorCredential: 'github-actions-token',
    detectorPermissions: { contents: 'read', packages: 'read' },
    detectorProof: 'anonymous-denied-then-authenticated-readable',
    hostAuthFile: 'root-only',
    hostCredential: 'sops-classic-pat',
    hostCredentialScope: 'read:packages',
    rotation: 'replace-verify-revoke',
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
    stdout: `anonymous-denied\nauthenticated:${DIGEST_A}\n`,
  });
  for (const fixture of [
    { access: 'private', anonymousReadable: 'true' },
    { access: 'private', registryToken: '' },
    { access: 'unexpected' },
  ]) {
    expect(runResolver(fixture).status).not.toBe(0);
  }
});
