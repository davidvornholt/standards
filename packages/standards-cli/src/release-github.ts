import { GithubStateError } from './github-state-error';
import { effectVoid, fail, flatMap, gen } from './release-effect';
import { loadGithubState, loadTagSha } from './release-github-api';
import {
  apiMessage,
  type GithubClient,
  post,
  type ReleaseFetcher,
} from './release-github-request';
import { decideReconciliation } from './release-state';

export type { ReleaseFetcher } from './release-github-request';

const HTTP_CREATED = 201;
const HTTP_UNPROCESSABLE = 422;
const RELEASE_NOTES_FIELD = 'generate_release_notes';
const TAG_NAME_FIELD = 'tag_name';
const TARGET_COMMIT_FIELD = 'target_commitish';

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

export const inspectGithubRelease = (input: GithubInput) =>
  loadGithubState(clientFrom(input), input.tag).pipe(
    flatMap((state) =>
      decideReconciliation({ expectedSha: input.expectedSha, ...state }),
    ),
  );

const requireExpectedTag = (input: GithubInput, tagSha: string | null) =>
  tagSha === input.expectedSha
    ? effectVoid
    : fail(
        new GithubStateError({
          message:
            tagSha === null
              ? `GitHub tag ${input.tag} is still absent after creation`
              : `Release tag points to ${tagSha}, expected ${input.expectedSha}`,
        }),
      );

const createAndVerifyTag = (client: GithubClient, input: GithubInput) =>
  gen(function* () {
    const existing = yield* loadTagSha(client, input.tag);
    if (existing !== null) {
      return yield* requireExpectedTag(input, existing);
    }
    const created = yield* post(client, `/repos/${client.repo}/git/refs`, {
      ref: `refs/tags/${input.tag}`,
      sha: input.expectedSha,
    });
    if (
      created.status !== HTTP_CREATED &&
      created.status !== HTTP_UNPROCESSABLE
    ) {
      return yield* fail(
        new GithubStateError({
          message: `Creating GitHub tag: HTTP ${created.status} ${apiMessage(created)}`,
        }),
      );
    }
    const readback = yield* loadTagSha(client, input.tag);
    return yield* requireExpectedTag(input, readback);
  });

const createRelease = (client: GithubClient, input: GithubInput) =>
  post(client, `/repos/${client.repo}/releases`, {
    [RELEASE_NOTES_FIELD]: true,
    name: input.tag,
    [TAG_NAME_FIELD]: input.tag,
    [TARGET_COMMIT_FIELD]: input.expectedSha,
  }).pipe(
    flatMap((created) =>
      created.status === HTTP_CREATED || created.status === HTTP_UNPROCESSABLE
        ? effectVoid
        : fail(
            new GithubStateError({
              message: `Creating GitHub release: HTTP ${created.status} ${apiMessage(created)}`,
            }),
          ),
    ),
  );

export const reconcileGithubRelease = (input: GithubInput) =>
  gen(function* () {
    const initial = yield* inspectGithubRelease(input);
    if (initial === 'exists') {
      return initial;
    }
    const client = clientFrom(input);
    yield* createAndVerifyTag(client, input);
    const beforeRelease = yield* inspectGithubRelease(input);
    if (beforeRelease === 'exists') {
      return beforeRelease;
    }
    yield* createRelease(client, input);
    const final = yield* inspectGithubRelease(input);
    if (final !== 'exists') {
      return yield* fail(
        new GithubStateError({
          message: 'GitHub release was not published after creation',
        }),
      );
    }
    return final;
  });
