import {
  apiMessage,
  type GithubClient,
  loadGithubState,
  loadTagSha,
  post,
  type ReleaseFetcher,
} from './release-github-api';
import {
  type Decision,
  decideReconciliation,
  type ReconciliationAction,
} from './release-state';

export type { ReleaseFetcher } from './release-github-api';

const HTTP_CREATED = 201;
const HTTP_UNPROCESSABLE = 422;
const RELEASE_NOTES_FIELD = 'generate_release_notes';
const TAG_NAME_FIELD = 'tag_name';

type GithubInput = {
  readonly apiUrl?: string;
  readonly expectedSha: string;
  readonly fetcher?: ReleaseFetcher;
  readonly repo: string;
  readonly tag: string;
  readonly token: string;
};

const clientFrom = (input: GithubInput): GithubClient => ({
  apiUrl: input.apiUrl ?? 'https://api.github.com',
  fetcher: input.fetcher ?? fetch,
  repo: input.repo,
  token: input.token,
});

export const inspectGithubRelease = async (
  input: GithubInput,
): Promise<Decision<ReconciliationAction>> => {
  const state = await loadGithubState(clientFrom(input), input.tag);
  return state.ok
    ? decideReconciliation({ expectedSha: input.expectedSha, ...state.value })
    : state;
};

const createTagIfMissing = async (
  client: GithubClient,
  input: GithubInput,
): Promise<Decision<true>> => {
  const tagSha = await loadTagSha(client, input.tag);
  if (!tagSha.ok) {
    return tagSha;
  }
  if (tagSha.value !== null) {
    return { ok: true, value: true };
  }
  const created = await post(client, `/repos/${client.repo}/git/refs`, {
    ref: `refs/tags/${input.tag}`,
    sha: input.expectedSha,
  });
  if (!created.ok) {
    return created;
  }
  return created.value.status === HTTP_CREATED ||
    created.value.status === HTTP_UNPROCESSABLE
    ? { ok: true, value: true }
    : {
        error: `Creating GitHub tag: HTTP ${created.value.status} ${apiMessage(created.value)}`,
        ok: false,
      };
};

export const reconcileGithubRelease = async (
  input: GithubInput,
): Promise<Decision<ReconciliationAction>> => {
  const client = clientFrom(input);
  const initial = await inspectGithubRelease(input);
  if (!initial.ok || initial.value === 'exists') {
    return initial;
  }
  const tag = await createTagIfMissing(client, input);
  if (!tag.ok) {
    return tag;
  }
  const beforeRelease = await inspectGithubRelease(input);
  if (!beforeRelease.ok || beforeRelease.value === 'exists') {
    return beforeRelease;
  }
  const created = await post(client, `/repos/${client.repo}/releases`, {
    [RELEASE_NOTES_FIELD]: true,
    name: input.tag,
    [TAG_NAME_FIELD]: input.tag,
  });
  if (!created.ok) {
    return created;
  }
  if (
    created.value.status !== HTTP_CREATED &&
    created.value.status !== HTTP_UNPROCESSABLE
  ) {
    return {
      error: `Creating GitHub release: HTTP ${created.value.status} ${apiMessage(created.value)}`,
      ok: false,
    };
  }
  const final = await inspectGithubRelease(input);
  if (!final.ok) {
    return final;
  }
  return final.value === 'exists'
    ? final
    : { error: 'GitHub release was not published after creation', ok: false };
};
