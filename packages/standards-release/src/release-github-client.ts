import type { GithubClient, ReleaseFetcher } from './release-github-request';

export type GithubConnectionInput = {
  readonly apiUrl?: string;
  readonly fetcher?: ReleaseFetcher;
  readonly repo: string;
  readonly token: string;
};

export const githubClientFrom = (
  input: GithubConnectionInput,
): GithubClient => ({
  apiUrl: input.apiUrl ?? 'https://api.github.com',
  fetcher: input.fetcher ?? fetch,
  repo: input.repo,
  token: input.token,
});
