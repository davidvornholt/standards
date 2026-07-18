// GitHub API plumbing for declarative repository settings: token and repo
// resolution, a minimal fetch wrapper, and shared loaders. The check/apply
// commands live in github-commands.ts.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import {
  type LoadedGithubSettings,
  loadGithubSettings,
} from './github-settings';
import { isRecord } from './github-settings-parse';

const API_ROOT = 'https://api.github.com';

const GITHUB_REMOTE_PATTERN =
  /github\.com[/:](?<repo>[^/]+\/[^/]+?)(?:\.git)?$/u;

export const HTTP_OK = 200;
export const HTTP_CREATED = 201;
export const HTTP_NO_CONTENT = 204;

export const CANONICAL_SETTINGS_FILE = '.github/settings.json';
export const LOCAL_SETTINGS_FILE = '.github/settings.local.json';

const quietExec = (
  file: string,
  args: ReadonlyArray<string>,
): string | null => {
  try {
    const out = execFileSync(file, [...args], {
      encoding: 'utf8',
      env: process.env,
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

export const resolveGithubRepo = (consumer: string): string | null => {
  const url = quietExec('git', ['-C', consumer, 'remote', 'get-url', 'origin']);
  return url?.match(GITHUB_REMOTE_PATTERN)?.groups?.repo ?? null;
};

export type ApiResponse = { readonly status: number; readonly body: unknown };

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

export const apiError = (context: string, response: ApiResponse): string => {
  const message =
    isRecord(response.body) && typeof response.body.message === 'string'
      ? response.body.message
      : 'unexpected response';
  return `${context}: HTTP ${response.status} ${message}`;
};

export const loadDeclared = async (
  consumer: string,
): Promise<LoadedGithubSettings> => {
  const canonicalPath = join(consumer, CANONICAL_SETTINGS_FILE);
  if (!existsSync(canonicalPath)) {
    return {
      merged: null,
      problems: [
        `${CANONICAL_SETTINGS_FILE} not found; run \`bun standards sync\` first`,
      ],
    };
  }
  const localPath = join(consumer, LOCAL_SETTINGS_FILE);
  return loadGithubSettings(
    await readFile(canonicalPath, 'utf8'),
    existsSync(localPath) ? await readFile(localPath, 'utf8') : null,
  );
};

const GRAPHQL_MERGE_FIELDS: ReadonlyMap<string, string> = new Map([
  ['allow_auto_merge', 'autoMergeAllowed'],
  ['allow_merge_commit', 'mergeCommitAllowed'],
  ['allow_rebase_merge', 'rebaseMergeAllowed'],
  ['allow_squash_merge', 'squashMergeAllowed'],
  ['delete_branch_on_merge', 'deleteBranchOnMerge'],
  ['merge_commit_message', 'mergeCommitMessage'],
  ['merge_commit_title', 'mergeCommitTitle'],
  ['squash_merge_commit_message', 'squashMergeCommitMessage'],
  ['squash_merge_commit_title', 'squashMergeCommitTitle'],
]);

// REST omits repository merge settings for read-only viewers (they surface
// only with write access — community discussion #153258), but GraphQL serves
// the same values, with identical enum spellings, to any token that can read
// the repository. This keeps a read-only PAT sufficient for the check.
// Returns only the keys GraphQL answered; the rest stay unverifiable.
export const fetchMergeSettingsViaGraphql = async (
  token: string | null,
  repo: string,
  keys: ReadonlyArray<string>,
): Promise<Readonly<Record<string, unknown>>> => {
  const mapped = keys.filter((key) => GRAPHQL_MERGE_FIELDS.has(key));
  const [owner, name] = repo.split('/');
  if (mapped.length === 0 || owner === undefined || name === undefined) {
    return {};
  }
  const fields = mapped.map((key) => GRAPHQL_MERGE_FIELDS.get(key)).join(' ');
  const response = await request(token, 'POST', '/graphql', {
    query: `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`,
  });
  if (response.status !== HTTP_OK || !isRecord(response.body)) {
    return {};
  }
  const data = isRecord(response.body.data) ? response.body.data : null;
  const repository =
    data !== null && isRecord(data.repository) ? data.repository : null;
  if (repository === null) {
    return {};
  }
  return Object.fromEntries(
    mapped
      .map((key) => [key, repository[GRAPHQL_MERGE_FIELDS.get(key) ?? '']])
      .filter(([, value]) => value !== undefined && value !== null),
  );
};

export type LiveRulesets = {
  readonly rulesets: ReadonlyArray<Record<string, unknown>> | null;
  readonly problem: string | null;
};

// Only repository-sourced rulesets are managed; org-level rulesets a consumer
// inherits are outside this declaration's authority.
export const fetchLiveRulesets = async (
  token: string | null,
  repo: string,
): Promise<LiveRulesets> => {
  const list = await request(token, 'GET', `/repos/${repo}/rulesets`);
  if (list.status !== HTTP_OK || !Array.isArray(list.body)) {
    return { rulesets: null, problem: apiError('listing rulesets', list) };
  }
  const repoOwned = list.body
    .filter(isRecord)
    .filter((ruleset) => ruleset.source_type === 'Repository');
  const detailed = await Promise.all(
    repoOwned.map((ruleset) =>
      request(token, 'GET', `/repos/${repo}/rulesets/${ruleset.id}`),
    ),
  );
  const failed = detailed.find((response) => response.status !== HTTP_OK);
  if (failed !== undefined) {
    return { rulesets: null, problem: apiError('reading a ruleset', failed) };
  }
  return {
    rulesets: detailed.map((response) => response.body).filter(isRecord),
    problem: null,
  };
};
