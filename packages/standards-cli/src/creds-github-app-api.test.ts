import { afterEach, describe, expect, it } from 'bun:test';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import {
  createGithubAppJwt,
  resolveGithubAppOwner,
  verifyGithubAppInstallation,
} from './creds-github-app-api';

const HTTP_NOT_FOUND = 404;
const HTTP_OK = 200;
const NOW = Date.parse('2026-07-26T12:00:00Z');
const MILLISECONDS_PER_SECOND = 1000;
const JWT_CLOCK_SKEW_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 540;
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const PRIVATE_KEY = privateKey
  .export({
    format: 'pem',
    type: 'pkcs1',
  })
  .toString();
const APP = {
  owner: 'example',
  appId: 42,
  slug: 'standards-broker-example',
  htmlUrl: 'https://github.com/apps/standards-broker-example',
  clientId: 'Iv1.example',
  privateKey: PRIVATE_KEY,
};
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('GitHub App authentication', () => {
  it('signs a short-lived RS256 JWT with the App client ID', () => {
    const jwt = createGithubAppJwt(APP, NOW);
    const [header, payload, signature] = jwt.split('.');
    expect(
      JSON.parse(Buffer.from(header ?? '', 'base64url').toString()),
    ).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(
      JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()),
    ).toEqual({
      iat: Math.floor(NOW / MILLISECONDS_PER_SECOND) - JWT_CLOCK_SKEW_SECONDS,
      exp: Math.floor(NOW / MILLISECONDS_PER_SECOND) + JWT_LIFETIME_SECONDS,
      iss: APP.clientId,
    });
    expect(
      createVerify('RSA-SHA256')
        .update(`${header}.${payload}`)
        .verify(publicKey, signature ?? '', 'base64url'),
    ).toBe(true);
  });

  it('resolves the owner from the authenticated App identity', async () => {
    globalThis.fetch = ((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        Response.json(
          { id: APP.appId, owner: { login: 'Example' } },
          { status: HTTP_OK },
        ),
      )) as typeof fetch;

    expect(await resolveGithubAppOwner(APP)).toEqual({
      ok: true,
      value: 'Example',
    });
  });
});

describe('GitHub App repository installation verification', () => {
  it('accepts only the selected App installed on the repository owner', async () => {
    globalThis.fetch = ((input: string | URL | Request) => {
      expect(String(input)).toBe(
        'https://api.github.com/repos/example/repository/installation',
      );
      return Promise.resolve(
        Response.json(
          {
            // biome-ignore lint/style/useNamingConvention: GitHub's response field is snake_case.
            app_id: APP.appId,
            account: { login: 'Example' },
          },
          { status: HTTP_OK },
        ),
      );
    }) as typeof fetch;

    expect(
      await verifyGithubAppInstallation(APP, 'example/repository'),
    ).toEqual({ ok: true, value: true });
  });

  it('fails actionably when the App is not installed on the repository', async () => {
    globalThis.fetch = ((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        Response.json({ message: 'Not Found' }, { status: HTTP_NOT_FOUND }),
      )) as typeof fetch;

    const result = await verifyGithubAppInstallation(APP, 'example/repository');
    expect(result).toEqual({
      ok: false,
      problem: expect.stringContaining(
        'is not installed on example/repository',
      ),
    });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);
  });
});
