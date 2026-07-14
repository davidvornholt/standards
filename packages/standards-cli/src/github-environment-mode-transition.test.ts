import { afterEach, describe, expect, it } from 'bun:test';
import { applyEnvironment } from './github-environment-apply';
import {
  declaration,
  installStatefulServer,
} from './github-environment-mode-server.test-fixture';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('environment branch-policy mode transitions', () => {
  it('uses branch endpoints only while custom mode is enabled', async () => {
    const disabling = installStatefulServer(originalFetch, 'production', {
      custom: true,
      policies: ['old/*'],
    });
    await applyEnvironment(
      'token',
      'owner/repo',
      declaration('production', false, []),
    );
    expect(disabling.calls.map((call) => call.split(' ')[0])).toEqual([
      'GET',
      'GET',
      'GET',
      'DELETE',
      'PUT',
    ]);

    const enabling = installStatefulServer(originalFetch, 'production', {
      custom: false,
    });
    await applyEnvironment(
      'token',
      'owner/repo',
      declaration('production', true, ['release/*']),
    );
    expect(enabling.calls.map((call) => call.split(' ')[0])).toEqual([
      'GET',
      'GET',
      'PUT',
      'POST',
    ]);
    expect(enabling.bodies.at(-1)).toEqual({ name: 'release/*' });
  });

  it('creates replacement policies before destructive custom-mode deletes', async () => {
    const server = installStatefulServer(originalFetch, 'production', {
      custom: true,
      policies: ['old/*'],
    });
    await applyEnvironment(
      'token',
      'owner/repo',
      declaration('production', true, ['release/*']),
    );
    expect(server.calls.map((call) => call.split(' ')[0])).toEqual([
      'GET',
      'GET',
      'GET',
      'POST',
      'DELETE',
    ]);
  });

  it('restores deleted policies when disabling custom mode fails', async () => {
    const reported: Array<string> = [];
    const server = installStatefulServer(originalFetch, 'production', {
      custom: true,
      policies: ['old/*'],
      putFails: true,
    });
    await expect(
      applyEnvironment(
        'token',
        'owner/repo',
        declaration('production', false, []),
        (action) => reported.push(action),
      ),
    ).rejects.toThrow(
      'protection failed; compensation restored every deleted deployment policy',
    );
    expect(server.policies).toEqual(new Set(['old/*']));
    expect(reported).toEqual([
      'deleted undeclared deployment policy "old/*" from environment "production"',
      'restored deployment policy "old/*" for environment "production" after failed protection update',
    ]);
  });

  it('preserves the protection and compensation failures together', async () => {
    installStatefulServer(originalFetch, 'production', {
      custom: true,
      policies: ['old/*'],
      putFails: true,
      restoreFails: true,
    });
    await expect(
      applyEnvironment(
        'token',
        'owner/repo',
        declaration('production', false, []),
      ),
    ).rejects.toThrow(
      'protection failed; compensation failed: restoring deployment policy "old/*" in "production": HTTP 500 restore failed',
    );
  });

  it('classifies protection drift structurally for reserved-substring names', async () => {
    const name =
      'deployment_branch_policies-custom_deployment_protection_rules';
    const server = installStatefulServer(originalFetch, name, {
      custom: false,
      waitTimer: 5,
    });
    await applyEnvironment('token', 'owner/repo', declaration(name, false, []));
    expect(server.calls.map((call) => call.split(' ')[0])).toEqual([
      'GET',
      'GET',
      'PUT',
    ]);
  });
});
