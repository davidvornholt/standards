import { afterEach, describe, expect, it } from 'bun:test';
import { verifyAutomationEnvironments } from './automation-verify';
import {
  api,
  BRANCH_POLICY_ID,
  ENVIRONMENT_ID,
  fixture,
  HTTP_FORBIDDEN,
  HTTP_NOT_FOUND,
  LEGACY_RECIPIENT,
  response,
  verify,
} from './automation-verify-test-support';
import { cleanupTmpDirs, write } from './cli-test-support';

afterEach(cleanupTmpDirs);

describe('automation environment verifier', () => {
  it('records immutable identity and exact-main environment evidence', async () => {
    const proof = await verify();
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
      verify({ '/orgs/owner': response({ plan: { name: 'free' } }) }),
    ).rejects.toThrow('observed unsupported plan "free"');
  });

  it.each([
    'team',
    'business',
    'enterprise',
  ])('accepts the documented private organization plan %s', async (name) => {
    const proof = await verify({
      '/orgs/owner': response({ plan: { name } }),
    });
    expect(proof.repository.ownerPlan).toBe(name);
  });

  it('rejects an unknown private organization plan', async () => {
    await expect(
      verify({ '/orgs/owner': response({ plan: { name: 'mystery' } }) }),
    ).rejects.toThrow('observed unsupported plan "mystery"');
  });

  it('accepts only Pro for a private personal repository', async () => {
    const personalRepository = response({
      id: 1,
      full_name: 'owner/repo',
      private: true,
      default_branch: 'main',
      owner: { id: 2, login: 'owner', type: 'User' },
    });
    const proof = await verify({
      '/repos/owner/repo': personalRepository,
      '/user': response({ login: 'owner', plan: { name: 'pro' } }),
    });
    expect(proof.repository.ownerPlan).toBe('pro');

    await expect(
      verify({
        '/repos/owner/repo': personalRepository,
        '/user': response({ login: 'owner', plan: { name: 'mystery' } }),
      }),
    ).rejects.toThrow('observed unsupported plan "mystery"');
  });

  it('fails when organization secret scope is not observable', async () => {
    await expect(
      verify({
        '/orgs/owner/actions/secrets?per_page=100': response(
          { message: 'forbidden' },
          HTTP_FORBIDDEN,
        ),
      }),
    ).rejects.toThrow('organization secret scope must be observable');
  });

  it('rejects a missing environment instead of allowing auto-creation', async () => {
    await expect(
      verify({
        '/repos/owner/repo/environments/standards-sync': response(
          { message: 'not found' },
          HTTP_NOT_FOUND,
        ),
      }),
    ).rejects.toThrow('reading automation environment: HTTP 404');
  });

  it('rejects same-named repository fallback secrets', async () => {
    await expect(
      verify({
        '/repos/owner/repo/actions/secrets?per_page=100': response({
          total_count: 1,
          secrets: [{ name: 'STANDARDS_SYNC_SOPS_AGE_KEY' }],
        }),
      }),
    ).rejects.toThrow('must be absent at repository scope');
  });

  it('rejects reuse of the retained legacy workflow recipient', async () => {
    const consumer = fixture();
    write(
      consumer,
      'sync-standards.local.json',
      JSON.stringify({
        automation: {
          environment: 'standards-sync',
          ageKeySecret: 'STANDARDS_SYNC_SOPS_AGE_KEY',
          secretTarget: 'standards-sync',
          brokerAppKey: 'github.repository_app',
          ageRecipient: LEGACY_RECIPIENT,
        },
        recoveryAgeRecipients: [],
      }),
    );
    await expect(
      verifyAutomationEnvironments({
        consumer,
        token: 'test-admin-token',
        api: api(),
      }),
    ).rejects.toThrow(
      'automation age recipient must be distinct from every legacy CI age recipient',
    );
  });
});
