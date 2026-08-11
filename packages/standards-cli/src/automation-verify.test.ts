import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { verifyAutomationEnvironments } from './automation-verify';
import { cleanupTmpDirs, mkTmp, write } from './cli-test-support';
import type { ApiResponse } from './github-api';
import { CI_SOPS_METADATA_YAML } from './structure-test-support';

afterEach(cleanupTmpDirs);

const RECIPIENT = 'age1automationrecipient000000000000000000000000000000000000';
const HTTP_NOT_FOUND = 404;
const ENVIRONMENT_ID = 10;
const BRANCH_POLICY_ID = 20;

const fixture = (): string => {
  const consumer = mkTmp('automation-verifier-');
  execFileSync('git', ['init', '--quiet', consumer]);
  execFileSync('git', [
    '-C',
    consumer,
    'remote',
    'add',
    'origin',
    'git@github.com:owner/repo.git',
  ]);
  write(
    consumer,
    'sync-standards.local.json',
    JSON.stringify({
      automation: {
        environment: 'standards-sync',
        ageKeySecret: 'STANDARDS_SYNC_SOPS_AGE_KEY',
        secretTarget: 'standards-sync',
        brokerAppKey: 'github.repository_app',
        ageRecipient: RECIPIENT,
      },
      recoveryAgeRecipients: [],
    }),
  );
  write(
    consumer,
    'secrets/ci.yaml',
    `ci:\n  retained: ENC[AES256_GCM,data:eA==,iv:aWl2,tag:dGFn,type:str]\n${CI_SOPS_METADATA_YAML}`,
  );
  return consumer;
};

const response = (body: unknown, status = 200): ApiResponse => ({
  status,
  body,
});

const api = (overrides: Readonly<Record<string, ApiResponse>> = {}) => {
  const defaults: Readonly<Record<string, ApiResponse>> = {
    '/repos/owner/repo': response({
      id: 1,
      full_name: 'owner/repo',
      private: true,
      default_branch: 'main',
      owner: { id: 2, login: 'owner', type: 'Organization' },
    }),
    '/user': response({ login: 'admin' }),
    '/repos/owner/repo/collaborators/admin/permission': response({
      user: { permissions: { admin: true } },
    }),
    '/orgs/owner': response({ plan: { name: 'team' } }),
    '/repos/owner/repo/environments/standards-sync': response({
      id: ENVIRONMENT_ID,
      deployment_branch_policy: {
        protected_branches: false,
        custom_branch_policies: true,
      },
    }),
    '/repos/owner/repo/environments/standards-sync/deployment-branch-policies?per_page=100':
      response({
        total_count: 1,
        branch_policies: [
          { id: BRANCH_POLICY_ID, name: 'main', type: 'branch' },
        ],
      }),
    '/repos/owner/repo/environments/standards-sync/secrets?per_page=100':
      response({
        total_count: 1,
        secrets: [{ name: 'STANDARDS_SYNC_SOPS_AGE_KEY' }],
      }),
    '/repos/owner/repo/actions/secrets?per_page=100': response({
      total_count: 0,
      secrets: [],
    }),
    '/orgs/owner/actions/secrets?per_page=100': response({
      total_count: 0,
      secrets: [],
    }),
  };
  return (
    _token: string | null,
    _method: string,
    path: string,
  ): Promise<ApiResponse> =>
    Promise.resolve(
      overrides[path] ??
        defaults[path] ??
        response({ message: 'not found' }, HTTP_NOT_FOUND),
    );
};

describe('automation environment verifier', () => {
  it('records immutable identity and exact-main environment evidence', async () => {
    const proof = await verifyAutomationEnvironments(
      fixture(),
      api(),
      Date.parse('2026-08-11T10:00:00Z'),
    );
    expect(proof.repository).toEqual({
      id: 1,
      ownerId: 2,
      fullName: 'owner/repo',
      private: true,
      defaultBranch: 'main',
      ownerType: 'Organization',
      ownerPlan: 'team',
      capability: 'paid-private-owner',
    });
    expect(proof.planes.automation).toMatchObject({
      environmentId: ENVIRONMENT_ID,
      branchPolicyIds: [BRANCH_POLICY_ID],
      repositorySecretAbsent: true,
      organizationSecret: 'absent',
    });
  });

  it('rejects a private Free repository before adoption', async () => {
    await expect(
      verifyAutomationEnvironments(
        fixture(),
        api({ '/orgs/owner': response({ plan: { name: 'free' } }) }),
      ),
    ).rejects.toThrow('require GitHub Pro/Team/Enterprise');
  });

  it('rejects a missing environment instead of allowing auto-creation', async () => {
    await expect(
      verifyAutomationEnvironments(
        fixture(),
        api({
          '/repos/owner/repo/environments/standards-sync': response(
            { message: 'not found' },
            HTTP_NOT_FOUND,
          ),
        }),
      ),
    ).rejects.toThrow('reading automation environment: HTTP 404');
  });

  it('rejects same-named repository fallback secrets', async () => {
    await expect(
      verifyAutomationEnvironments(
        fixture(),
        api({
          '/repos/owner/repo/actions/secrets?per_page=100': response({
            total_count: 1,
            secrets: [{ name: 'STANDARDS_SYNC_SOPS_AGE_KEY' }],
          }),
        }),
      ),
    ).rejects.toThrow('must be absent at repository scope');
  });
});
