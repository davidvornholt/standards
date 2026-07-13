import { GithubApiError } from './github-api-error';
import { effectTry, gen, tryPromise } from './release-effect';

export type ReleaseFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const apiMessage = (response: ApiResponse): string =>
  isRecord(response.body) && typeof response.body.message === 'string'
    ? response.body.message
    : 'unexpected response';

const parseResponse = (response: Response, text: string) =>
  effectTry({
    try: () => ({
      body: text.length === 0 ? null : (JSON.parse(text) as unknown),
      status: response.status,
    }),
    catch: () =>
      new GithubApiError({
        message: `GitHub API returned invalid JSON with HTTP ${response.status}`,
      }),
  });

const request = (input: {
  readonly body: unknown | null;
  readonly client: GithubClient;
  readonly method: 'GET' | 'POST';
  readonly path: string;
}) =>
  gen(function* () {
    const response = yield* tryPromise({
      try: () =>
        input.client.fetcher(`${input.client.apiUrl}${input.path}`, {
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
        }),
      catch: (cause) =>
        new GithubApiError({
          message: `GitHub API request failed: ${String(cause)}`,
        }),
    });
    const text = yield* tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new GithubApiError({
          message: `Reading GitHub API response failed: ${String(cause)}`,
        }),
    });
    return yield* parseResponse(response, text);
  });

export const get = (client: GithubClient, path: string) =>
  request({ body: null, client, method: 'GET', path });

export const post = (client: GithubClient, path: string, body: unknown) =>
  request({ body, client, method: 'POST', path });
