import { afterEach, expect, it } from 'bun:test';
import { HTTP_NO_CONTENT, HTTP_OK } from './github-api';
import { applyEnvironment } from './github-environment-apply';
import {
  customPath,
  customRules,
  declared,
  environment,
  HTTP_ERROR,
  installFetch,
  originalFetch,
  response,
} from './github-environment-reconciliation-test-fixture';

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it('reports a verified protection update before a later delete failure', async () => {
  const calls: Array<string> = [];
  const reported: Array<string> = [];
  const environments = [environment(true), environment(false, 0)];
  installFetch((url, method) => {
    if (method === 'PUT') {
      return response(HTTP_OK, {});
    }
    if (method === 'DELETE') {
      return response(HTTP_ERROR, { message: 'custom delete failed' });
    }
    return response(
      HTTP_OK,
      url.includes(customPath) ? customRules(true) : environments.shift(),
    );
  }, calls);

  await expect(
    applyEnvironment('token', 'owner/repo', declared, (action) =>
      reported.push(action),
    ),
  ).rejects.toThrow('deleting custom deployment protection rule');
  expect(reported).toEqual(['updated environment "production" protection']);
});

it('fails after deletion when final managed state still drifts', async () => {
  const calls: Array<string> = [];
  const reported: Array<string> = [];
  const environments = [
    environment(true),
    environment(false, 0),
    environment(true),
  ];
  installFetch((url, method) => {
    if (method === 'PUT') {
      return response(HTTP_OK, {});
    }
    if (method === 'DELETE') {
      return response(HTTP_NO_CONTENT);
    }
    return response(
      HTTP_OK,
      url.includes(customPath) ? customRules(true) : environments.shift(),
    );
  }, calls);

  await expect(
    applyEnvironment('token', 'owner/repo', declared, (action) =>
      reported.push(action),
    ),
  ).rejects.toThrow('did not match the declaration after apply');
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
  expect(reported).toEqual([
    'updated environment "production" protection',
    'deleted undeclared custom deployment protection rule "external-gate" from environment "production"',
  ]);
});

it('revalidates converged protection before deleting a custom rule', async () => {
  const calls: Array<string> = [];
  const rules = [customRules(true), customRules(true), customRules(false)];
  installFetch((url, method) => {
    if (method === 'DELETE') {
      return response(HTTP_NO_CONTENT);
    }
    return response(
      HTTP_OK,
      url.includes(customPath) ? rules.shift() : environment(false, 0),
    );
  }, calls);

  expect(await applyEnvironment('token', 'owner/repo', declared)).toEqual([
    'deleted undeclared custom deployment protection rule "external-gate" from environment "production"',
  ]);
  expect(calls.map((call) => call.split(' ')[0])).toEqual([
    'GET',
    'GET',
    'GET',
    'GET',
    'DELETE',
    'GET',
    'GET',
  ]);
});
