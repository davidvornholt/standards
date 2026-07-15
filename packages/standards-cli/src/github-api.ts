// GitHub API plumbing for declarative repository settings: token and repo
// resolution, a minimal fetch wrapper, and shared loaders. The check/apply
// commands live in github-commands.ts.

import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { isRecord } from './github-settings';

const API_ROOT = 'https://api.github.com';
const SCP_GITHUB_REMOTE = /^git@github\.com:(?<path>[^:]+)$/u;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+$/u;
const GIT_SUFFIX = /\.git$/iu;

export const HTTP_OK = 200;
export const HTTP_CREATED = 201;
export const HTTP_NO_CONTENT = 204;
export const HTTP_NOT_FOUND = 404;

export const CANONICAL_SETTINGS_FILE = '.github/settings.json';
export const LOCAL_SETTINGS_FILE = '.github/settings.local.json';

const quietExec = (
  file: string,
  args: ReadonlyArray<string>,
): string | null => {
  try {
    const out = execFileSync(file, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
};

// GH_TOKEN or GITHUB_TOKEN, else the local gh CLI. Null is still usable for
// reads on public repositories.
export const resolveToken = (): string | null => {
  const fromEnv = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return quietExec('gh', ['auth', 'token']);
};

const repositoryFromPath = (path: string): string | null => {
  const parts = path.split('/');
  if (parts.length !== 2) {
    return null;
  }
  const owner = parts[0] as string;
  const rawRepository = parts[1] as string;
  const repository = rawRepository.replace(GIT_SUFFIX, '');
  if (
    !(GITHUB_OWNER.test(owner) && GITHUB_REPOSITORY.test(repository)) ||
    repository === '.' ||
    repository === '..'
  ) {
    return null;
  }
  return `${owner}/${repository}`;
};

export const githubRepositoryFromRemote = (remote: string): string | null => {
  const scpPath = SCP_GITHUB_REMOTE.exec(remote)?.groups?.path;
  if (scpPath !== undefined) {
    return repositoryFromPath(scpPath);
  }
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return null;
  }
  const supportedHttps =
    url.protocol === 'https:' &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.port.length === 0;
  const supportedSsh =
    url.protocol === 'ssh:' &&
    url.username === 'git' &&
    url.password.length === 0 &&
    (url.port.length === 0 || url.port === '22');
  if (
    url.hostname !== 'github.com' ||
    !(supportedHttps || supportedSsh) ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !url.pathname.startsWith('/')
  ) {
    return null;
  }
  return repositoryFromPath(url.pathname.slice(1));
};

export const resolveGithubRepo = (consumer: string): string | null => {
  const url = quietExec('git', ['-C', consumer, 'remote', 'get-url', 'origin']);
  return url === null ? null : githubRepositoryFromRemote(url);
};

export type ApiResponse = { readonly status: number; readonly body: unknown };

export type BeforeGithubMutation = () => Promise<void>;

type GithubMutation = {
  readonly beforeMutation: BeforeGithubMutation;
  readonly body?: unknown;
  readonly method: 'DELETE' | 'PATCH' | 'POST' | 'PUT';
  readonly path: string;
  readonly token: string;
};

export const request = async (
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse> => {
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text.length === 0 ? null : (JSON.parse(text) as unknown);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
};

export const noGithubMutationGuard: BeforeGithubMutation = () =>
  Promise.resolve();

export const mutate = async (input: GithubMutation): Promise<ApiResponse> => {
  await input.beforeMutation();
  return request(input.token, input.method, input.path, input.body);
};

export const apiError = (context: string, response: ApiResponse): string => {
  const message =
    isRecord(response.body) && typeof response.body.message === 'string'
      ? response.body.message
      : 'unexpected response';
  return `${context}: HTTP ${response.status} ${message}`;
};
