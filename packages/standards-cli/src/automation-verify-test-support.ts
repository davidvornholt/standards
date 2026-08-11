import { execFileSync } from 'node:child_process';
import { verifyAutomationEnvironments } from './automation-verify';
import { mkTmp, write } from './cli-test-support';
import type { ApiResponse } from './github-api';
import { CI_SOPS_METADATA_YAML } from './structure-test-support';

export const RECIPIENT =
  'age1automationrecipient000000000000000000000000000000000000';
export const LEGACY_RECIPIENT =
  'age1legacyrecipient00000000000000000000000000000000000000';
export const HTTP_NOT_FOUND = 404;
export const HTTP_FORBIDDEN = 403;
export const ENVIRONMENT_ID = 10;
export const BRANCH_POLICY_ID = 20;

export const fixture = (): string => {
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
    `ci:\n  retained: ENC[AES256_GCM,data:eA==,iv:aWl2,tag:dGFn,type:str]\n${CI_SOPS_METADATA_YAML.replace('age1test', LEGACY_RECIPIENT)}`,
  );
  return consumer;
};

export const response = (body: unknown, status = 200): ApiResponse => ({
  status,
  body,
});

export const api = (overrides: Readonly<Record<string, ApiResponse>> = {}) => {
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
    '/repos/owner/repo/collaborators/owner/permission': response({
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
    token: string | null,
    _method: string,
    path: string,
  ): Promise<ApiResponse> => {
    if (token !== 'test-admin-token') {
      throw new Error('test verifier received an unexpected token');
    }
    return Promise.resolve(
      overrides[path] ??
        defaults[path] ??
        response({ message: 'not found' }, HTTP_NOT_FOUND),
    );
  };
};

export const verify = (
  overrides: Readonly<Record<string, ApiResponse>> = {},
  now = Date.parse('2026-08-11T10:00:00Z'),
) =>
  verifyAutomationEnvironments({
    consumer: fixture(),
    token: 'test-admin-token',
    api: api(overrides),
    now,
  });
