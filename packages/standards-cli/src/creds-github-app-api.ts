import { createSign } from 'node:crypto';
import type { GithubBrokerApp } from './creds-store';
import { type ApiResponse, apiError, HTTP_OK, request } from './github-api';
import { isNonEmptyString, isRecord } from './github-settings-parse';

const JWT_CLOCK_SKEW_SECONDS = 60;
const SECONDS_PER_MINUTE = 60;
const JWT_LIFETIME_MINUTES = 9;
const JWT_LIFETIME_SECONDS = JWT_LIFETIME_MINUTES * SECONDS_PER_MINUTE;
const MILLISECONDS_PER_SECOND = 1000;
const HTTP_NOT_FOUND = 404;

type GithubAppResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: string };

export const createGithubAppJwt = (
  app: GithubBrokerApp,
  now = Date.now(),
): string => {
  const seconds = Math.floor(now / MILLISECONDS_PER_SECOND);
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iat: seconds - JWT_CLOCK_SKEW_SECONDS,
      exp: seconds + JWT_LIFETIME_SECONDS,
      iss: app.clientId,
    }),
  ).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .sign(app.privateKey, 'base64url');
  return `${unsigned}.${signature}`;
};

const appRequest = async (
  app: GithubBrokerApp,
  path: string,
): Promise<GithubAppResult<ApiResponse>> => {
  try {
    return {
      ok: true,
      value: await request(createGithubAppJwt(app), 'GET', path),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      problem: `cannot authenticate as App ${app.slug}: ${message}`,
    };
  }
};

export const resolveGithubAppOwner = async (
  app: GithubBrokerApp,
): Promise<GithubAppResult<string>> => {
  const result = await appRequest(app, '/app');
  if (!result.ok) {
    return result;
  }
  if (result.value.status !== HTTP_OK) {
    return {
      ok: false,
      problem: apiError(`resolve owner for App ${app.slug}`, result.value),
    };
  }
  const { body } = result.value;
  if (
    !isRecord(body) ||
    body.id !== app.appId ||
    !isRecord(body.owner) ||
    !isNonEmptyString(body.owner.login)
  ) {
    return {
      ok: false,
      problem: `resolve owner for App ${app.slug}: unexpected response shape or App identity`,
    };
  }
  return { ok: true, value: body.owner.login };
};

export const verifyGithubAppInstallation = async (
  app: GithubBrokerApp,
  repo: string,
): Promise<GithubAppResult<true>> => {
  const [owner, name, ...rest] = repo.split('/');
  if (
    owner === undefined ||
    name === undefined ||
    owner.length === 0 ||
    name.length === 0 ||
    rest.length > 0
  ) {
    return { ok: false, problem: `invalid GitHub repository: ${repo}` };
  }
  const result = await appRequest(
    app,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
  );
  if (!result.ok) {
    return result;
  }
  if (result.value.status === HTTP_NOT_FOUND) {
    return {
      ok: false,
      problem: `App ${app.slug} for ${owner} is not installed on ${repo}; install it for that selected repository at ${app.htmlUrl}/installations/new`,
    };
  }
  if (result.value.status !== HTTP_OK) {
    return {
      ok: false,
      problem: apiError(`verify App installation on ${repo}`, result.value),
    };
  }
  const { body } = result.value;
  if (
    !isRecord(body) ||
    body.app_id !== app.appId ||
    !isRecord(body.account) ||
    !isNonEmptyString(body.account.login) ||
    body.account.login.toLowerCase() !== owner.toLowerCase()
  ) {
    return {
      ok: false,
      problem: `verify App installation on ${repo}: unexpected App or account identity`,
    };
  }
  return { ok: true, value: true };
};
