import type { Decision } from './release-state';

export type ReleaseFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type GithubState = {
  readonly releaseStatus: 'absent' | 'draft' | 'published';
  readonly tagSha: string | null;
};

export type ApiResponse = {
  readonly body: unknown;
  readonly status: number;
};

export type GithubClient = {
  readonly apiUrl: string;
  readonly fetcher: ReleaseFetcher;
  readonly repo: string;
  readonly token: string;
};

const HTTP_NOT_FOUND = 404;
const HTTP_OK = 200;
const MAX_TAG_DEPTH = 8;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const apiMessage = (response: ApiResponse): string =>
  isRecord(response.body) && typeof response.body.message === 'string'
    ? response.body.message
    : 'unexpected response';

const request = async (input: {
  readonly body: unknown | null;
  readonly client: GithubClient;
  readonly method: 'GET' | 'POST';
  readonly path: string;
}): Promise<Decision<ApiResponse>> => {
  let response: Response;
  try {
    response = await input.client.fetcher(
      `${input.client.apiUrl}${input.path}`,
      {
        body: input.body === null ? undefined : JSON.stringify(input.body),
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${input.client.token}`,
          'x-github-api-version': '2022-11-28',
          ...(input.body === null
            ? {}
            : { 'content-type': 'application/json' }),
        },
        method: input.method,
      },
    );
  } catch (error) {
    return { error: `GitHub API request failed: ${String(error)}`, ok: false };
  }
  const text = await response.text();
  try {
    return {
      ok: true,
      value: {
        body: text.length === 0 ? null : (JSON.parse(text) as unknown),
        status: response.status,
      },
    };
  } catch {
    return {
      error: `GitHub API returned invalid JSON with HTTP ${response.status}`,
      ok: false,
    };
  }
};

export const get = (client: GithubClient, path: string) =>
  request({ body: null, client, method: 'GET', path });

export const post = (client: GithubClient, path: string, body: unknown) =>
  request({ body, client, method: 'POST', path });

const objectIdentity = (
  response: ApiResponse,
  context: string,
): Decision<{ readonly sha: string; readonly type: string }> => {
  if (!(isRecord(response.body) && isRecord(response.body.object))) {
    return { error: `${context} returned invalid object metadata`, ok: false };
  }
  const { sha, type } = response.body.object;
  return typeof sha === 'string' && typeof type === 'string'
    ? { ok: true, value: { sha, type } }
    : { error: `${context} returned invalid object identity`, ok: false };
};

const peelTag = async (
  client: GithubClient,
  identity: { readonly sha: string; readonly type: string },
  depth: number,
): Promise<Decision<string>> => {
  if (identity.type === 'commit') {
    return { ok: true, value: identity.sha };
  }
  if (identity.type !== 'tag') {
    return {
      error: `GitHub tag resolves to ${identity.type}, expected commit`,
      ok: false,
    };
  }
  if (depth === MAX_TAG_DEPTH) {
    return { error: 'GitHub annotated tag chain is too deep', ok: false };
  }
  const tagObject = await get(
    client,
    `/repos/${client.repo}/git/tags/${identity.sha}`,
  );
  if (!tagObject.ok) {
    return tagObject;
  }
  if (tagObject.value.status !== HTTP_OK) {
    return {
      error: `Reading annotated GitHub tag: HTTP ${tagObject.value.status} ${apiMessage(tagObject.value)}`,
      ok: false,
    };
  }
  const next = objectIdentity(tagObject.value, 'GitHub annotated tag');
  return next.ok ? peelTag(client, next.value, depth + 1) : next;
};

export const loadTagSha = async (
  client: GithubClient,
  tag: string,
): Promise<Decision<string | null>> => {
  const reference = await get(
    client,
    `/repos/${client.repo}/git/ref/tags/${encodeURIComponent(tag)}`,
  );
  if (!reference.ok) {
    return reference;
  }
  if (reference.value.status === HTTP_NOT_FOUND) {
    return { ok: true, value: null };
  }
  if (reference.value.status !== HTTP_OK) {
    return {
      error: `Reading GitHub tag: HTTP ${reference.value.status} ${apiMessage(reference.value)}`,
      ok: false,
    };
  }
  const identity = objectIdentity(reference.value, 'GitHub tag reference');
  return identity.ok ? peelTag(client, identity.value, 0) : identity;
};

export const loadGithubState = async (
  client: GithubClient,
  tag: string,
): Promise<Decision<GithubState>> => {
  const release = await get(
    client,
    `/repos/${client.repo}/releases/tags/${encodeURIComponent(tag)}`,
  );
  if (!release.ok) {
    return release;
  }
  let releaseStatus: GithubState['releaseStatus'];
  if (release.value.status === HTTP_NOT_FOUND) {
    releaseStatus = 'absent';
  } else if (release.value.status === HTTP_OK && isRecord(release.value.body)) {
    if (typeof release.value.body.draft !== 'boolean') {
      return {
        error: 'GitHub release returned invalid draft state',
        ok: false,
      };
    }
    releaseStatus = release.value.body.draft ? 'draft' : 'published';
  } else {
    return {
      error: `Reading GitHub release: HTTP ${release.value.status} ${apiMessage(release.value)}`,
      ok: false,
    };
  }
  const tagSha = await loadTagSha(client, tag);
  return tagSha.ok
    ? { ok: true, value: { releaseStatus, tagSha: tagSha.value } }
    : tagSha;
};
