import { GithubApiError } from './github-api-error';
import {
  decodeUnknown,
  type Effect,
  fail,
  flatMap,
  gen,
  map,
  mapError,
  SchemaBoolean,
  SchemaString,
  Struct,
  succeed,
} from './release-effect';
import {
  type ApiResponse,
  apiMessage,
  type GithubClient,
  get,
} from './release-github-request';

export type { GithubClient, ReleaseFetcher } from './release-github-request';

export type GithubState = {
  readonly releaseStatus: 'absent' | 'draft' | 'published';
  readonly tagSha: string | null;
};

const HTTP_NOT_FOUND = 404;
const HTTP_OK = 200;
const MAX_TAG_DEPTH = 8;
const TAG_NAME_FIELD = 'tag_name';

const apiObjectSchema = Struct({
  object: Struct({ sha: SchemaString, type: SchemaString }),
});

const releaseSchema = Struct({
  draft: SchemaBoolean,
  [TAG_NAME_FIELD]: SchemaString,
});

const decodeObject = (response: ApiResponse, context: string) =>
  decodeUnknown(apiObjectSchema)(response.body).pipe(
    mapError(
      () =>
        new GithubApiError({
          message: `${context} returned invalid object identity`,
        }),
    ),
    map(({ object }) => object),
  );

const peelTag = (
  client: GithubClient,
  identity: { readonly sha: string; readonly type: string },
  depth: number,
): Effect<string, GithubApiError> => {
  if (identity.type === 'commit') {
    return succeed(identity.sha);
  }
  if (identity.type !== 'tag') {
    return fail(
      new GithubApiError({
        message: `GitHub tag resolves to ${identity.type}, expected commit`,
      }),
    );
  }
  if (depth === MAX_TAG_DEPTH) {
    return fail(
      new GithubApiError({ message: 'GitHub annotated tag chain is too deep' }),
    );
  }
  return get(client, `/repos/${client.repo}/git/tags/${identity.sha}`).pipe(
    flatMap((response) =>
      response.status === HTTP_OK
        ? decodeObject(response, 'GitHub annotated tag')
        : fail(
            new GithubApiError({
              message: `Reading annotated GitHub tag: HTTP ${response.status} ${apiMessage(response)}`,
            }),
          ),
    ),
    flatMap((next) => peelTag(client, next, depth + 1)),
  );
};

export const loadTagSha = (client: GithubClient, tag: string) =>
  get(
    client,
    `/repos/${client.repo}/git/ref/tags/${encodeURIComponent(tag)}`,
  ).pipe(
    flatMap((response) => {
      if (response.status === HTTP_NOT_FOUND) {
        return succeed(null);
      }
      if (response.status !== HTTP_OK) {
        return fail(
          new GithubApiError({
            message: `Reading GitHub tag: HTTP ${response.status} ${apiMessage(response)}`,
          }),
        );
      }
      return decodeObject(response, 'GitHub tag reference').pipe(
        flatMap((identity) => peelTag(client, identity, 0)),
      );
    }),
  );

export const loadGithubState = (client: GithubClient, tag: string) =>
  gen(function* () {
    const response = yield* get(
      client,
      `/repos/${client.repo}/releases/tags/${encodeURIComponent(tag)}`,
    );
    let releaseStatus: GithubState['releaseStatus'];
    if (response.status === HTTP_NOT_FOUND) {
      releaseStatus = 'absent';
    } else if (response.status === HTTP_OK) {
      const release = yield* decodeUnknown(releaseSchema)(response.body).pipe(
        mapError(
          () =>
            new GithubApiError({
              message: 'GitHub release returned invalid release state',
            }),
        ),
      );
      if (release[TAG_NAME_FIELD] !== tag) {
        return yield* fail(
          new GithubApiError({
            message: `GitHub release returned tag ${release[TAG_NAME_FIELD]}, expected ${tag}`,
          }),
        );
      }
      releaseStatus = release.draft ? 'draft' : 'published';
    } else {
      return yield* fail(
        new GithubApiError({
          message: `Reading GitHub release: HTTP ${response.status} ${apiMessage(response)}`,
        }),
      );
    }
    const tagSha = yield* loadTagSha(client, tag);
    return { releaseStatus, tagSha } satisfies GithubState;
  });
