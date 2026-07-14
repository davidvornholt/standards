import { afterEach, expect, it } from 'bun:test';
import { HTTP_NO_CONTENT, HTTP_OK } from './github-api';
import { applyEnvironment } from './github-environment-apply';
import {
  customPath,
  customRules,
  declared,
  environment,
  installFetch,
  originalFetch,
  response,
} from './github-environment-reconciliation-test-fixture';

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it('verifies an update before deleting custom rules and verifies the final state', async () => {
  const calls: Array<string> = [];
  const reported: Array<string> = [];
  const environments = [
    environment(true),
    environment(false, 0),
    environment(false, 0),
  ];
  const rules = [customRules(true), customRules(true), customRules(false)];
  installFetch((url, method) => {
    if (method === 'PUT') {
      return response(HTTP_OK, {});
    }
    if (method === 'DELETE') {
      return response(HTTP_NO_CONTENT);
    }
    return response(
      HTTP_OK,
      url.includes(customPath) ? rules.shift() : environments.shift(),
    );
  }, calls);

  const actions = await applyEnvironment(
    'token',
    'owner/repo',
    declared,
    (action) => reported.push(action),
  );

  expect(calls.map((call) => call.split(' ')[0])).toEqual([
    'GET',
    'GET',
    'PUT',
    'GET',
    'GET',
    'DELETE',
    'GET',
    'GET',
  ]);
  expect(calls[5]).toContain(customPath);
  expect(
    calls.every((call) => !call.includes('deployment-branch-policies')),
  ).toBe(true);
  expect(reported).toEqual([...actions]);
});

it('rejects an ignored update before any custom-rule delete', async () => {
  const calls: Array<string> = [];
  installFetch((url, method) => {
    if (method === 'PUT') {
      return response(HTTP_OK, {});
    }
    return response(
      HTTP_OK,
      url.includes(customPath) ? customRules(true) : environment(true),
    );
  }, calls);

  await expect(
    applyEnvironment('token', 'owner/repo', declared),
  ).rejects.toThrow(
    'protection did not match the declaration on verification readback',
  );
  expect(calls.map((call) => call.split(' ')[0])).toEqual([
    'GET',
    'GET',
    'PUT',
    'GET',
    'GET',
  ]);
  expect(calls.every((call) => !call.startsWith('DELETE '))).toBe(true);
});

it('rejects concurrent protection drift before any custom-rule delete', async () => {
  const calls: Array<string> = [];
  const environments = [environment(false, 0), environment(true)];
  installFetch(
    (url, _method) =>
      response(
        HTTP_OK,
        url.includes(customPath) ? customRules(true) : environments.shift(),
      ),
    calls,
  );

  await expect(
    applyEnvironment('token', 'owner/repo', declared),
  ).rejects.toThrow(
    'protection did not match the declaration on verification readback',
  );
  expect(calls.map((call) => call.split(' ')[0])).toEqual([
    'GET',
    'GET',
    'GET',
    'GET',
  ]);
  expect(calls.every((call) => !call.startsWith('DELETE '))).toBe(true);
});
