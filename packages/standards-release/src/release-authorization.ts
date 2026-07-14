import { GithubApiError } from './github-api-error';
import { GithubStateError } from './github-state-error';
import {
  decodeUnknown,
  fail,
  flatMap,
  gen,
  mapError,
  SchemaString,
  Struct,
  succeed,
} from './release-effect';
import {
  type GithubConnectionInput,
  githubClientFrom,
} from './release-github-client';
import { apiMessage, get } from './release-github-request';

const HTTP_OK = 200;
const DEFAULT_BRANCH = 'default_branch';
const MERGE_BASE_COMMIT = 'merge_base_commit';

const repositorySchema = Struct({ [DEFAULT_BRANCH]: SchemaString });
const comparisonSchema = Struct({
  [MERGE_BASE_COMMIT]: Struct({ sha: SchemaString }),
  status: SchemaString,
});

const requireOk = (
  context: string,
  response: {
    readonly body: unknown;
    readonly status: number;
  },
) =>
  response.status === HTTP_OK
    ? succeed(response)
    : fail(
        new GithubApiError({
          message: `${context}: HTTP ${response.status} ${apiMessage(response)}`,
        }),
      );

export const authorizeReleaseSha = (
  input: GithubConnectionInput & { readonly expectedSha: string },
) =>
  gen(function* () {
    const client = githubClientFrom(input);
    const repositoryResponse = yield* get(client, `/repos/${client.repo}`).pipe(
      flatMap((response) =>
        requireOk('Reading repository default branch', response),
      ),
    );
    const repository = yield* decodeUnknown(repositorySchema)(
      repositoryResponse.body,
    ).pipe(
      mapError(
        () =>
          new GithubApiError({
            message: 'GitHub repository returned an invalid default branch',
          }),
      ),
    );
    if (repository.default_branch.length === 0) {
      return yield* fail(
        new GithubApiError({
          message: 'GitHub repository returned an empty default branch',
        }),
      );
    }

    const base = encodeURIComponent(input.expectedSha);
    const head = encodeURIComponent(repository.default_branch);
    const comparisonResponse = yield* get(
      client,
      `/repos/${client.repo}/compare/${base}...${head}`,
    ).pipe(
      flatMap((response) =>
        requireOk('Comparing release SHA to default branch', response),
      ),
    );
    const comparison = yield* decodeUnknown(comparisonSchema)(
      comparisonResponse.body,
    ).pipe(
      mapError(
        () =>
          new GithubApiError({
            message: 'GitHub comparison returned invalid ancestry state',
          }),
      ),
    );
    const isAncestor =
      comparison.merge_base_commit.sha === input.expectedSha &&
      (comparison.status === 'ahead' || comparison.status === 'identical');
    if (!isAncestor) {
      return yield* fail(
        new GithubStateError({
          message: `Release SHA ${input.expectedSha} is not an ancestor of live default branch ${repository.default_branch}`,
        }),
      );
    }
    return repository.default_branch;
  });
