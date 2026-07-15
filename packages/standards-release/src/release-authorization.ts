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
import { apiMessage, type GithubClient, get } from './release-github-request';

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

const readDefaultBranch = (client: GithubClient) =>
  gen(function* () {
    const response = yield* get(client, `/repos/${client.repo}`).pipe(
      flatMap((repositoryResponse) =>
        requireOk('Reading repository default branch', repositoryResponse),
      ),
    );
    const repository = yield* decodeUnknown(repositorySchema)(
      response.body,
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
    return repository.default_branch;
  });

const assertReleaseShaAncestor = (input: {
  readonly client: GithubClient;
  readonly defaultBranch: string;
  readonly expectedSha: string;
  readonly operation: string;
}) =>
  gen(function* () {
    const base = encodeURIComponent(input.expectedSha);
    const head = encodeURIComponent(input.defaultBranch);
    const comparisonResponse = yield* get(
      input.client,
      `/repos/${input.client.repo}/compare/${base}...${head}`,
    ).pipe(flatMap((response) => requireOk(input.operation, response)));
    const comparison = yield* decodeUnknown(comparisonSchema)(
      comparisonResponse.body,
    ).pipe(
      mapError(
        () =>
          new GithubApiError({
            message: `${input.operation} returned invalid ancestry state`,
          }),
      ),
    );
    const isAncestor =
      comparison.merge_base_commit.sha === input.expectedSha &&
      (comparison.status === 'ahead' || comparison.status === 'identical');
    if (!isAncestor) {
      return yield* fail(
        new GithubStateError({
          message: `Release SHA ${input.expectedSha} is not an ancestor of live default branch ${input.defaultBranch}`,
        }),
      );
    }
  });

export const authorizeReleaseSha = (
  input: GithubConnectionInput & { readonly expectedSha: string },
) =>
  gen(function* () {
    const client = githubClientFrom(input);
    const defaultBranch = yield* readDefaultBranch(client);
    yield* assertReleaseShaAncestor({
      client,
      defaultBranch,
      expectedSha: input.expectedSha,
      operation: 'Comparing release SHA to default branch',
    });
    const confirmedDefaultBranch = yield* readDefaultBranch(client);
    if (confirmedDefaultBranch !== defaultBranch) {
      return yield* fail(
        new GithubStateError({
          message: `GitHub default branch changed from ${defaultBranch} to ${confirmedDefaultBranch} during release authorization`,
        }),
      );
    }
    yield* assertReleaseShaAncestor({
      client,
      defaultBranch: confirmedDefaultBranch,
      expectedSha: input.expectedSha,
      operation: 'Reconfirming release SHA ancestry on default branch',
    });
    return defaultBranch;
  });
