import { expect, it } from 'bun:test';
import { yamlContract } from './image-promotion-reference-contract-test-support';

type RegistryAccessContract = {
  readonly forbiddenDesiredStateFields: ReadonlyArray<string>;
  readonly private: {
    readonly workflowCredential: string;
    readonly workflowPermissions: Readonly<Record<string, string>>;
    readonly workflowProof: string;
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
    readonly workflowCredential: string;
    readonly workflowProof: string;
    readonly hostAuthFile: string;
    readonly hostCredential: string;
  };
};

const registry = yamlContract<RegistryAccessContract>('registry-access');
it('declares separate public and private access planes with honest PAT authority', () => {
  expect(registry.public).toEqual({
    workflowCredential: 'none',
    workflowProof: 'anonymously-readable',
    hostAuthFile: '/run/containers/auth/anonymous.json',
    hostCredential: 'none',
  });
  expect(registry.private).toEqual({
    workflowCredential: 'github-actions-token',
    workflowPermissions: { contents: 'read', packages: 'read' },
    workflowProof:
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
