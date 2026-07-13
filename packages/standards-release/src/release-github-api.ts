import { GithubApiError } from './github-api-error';
import {
  decodeUnknown,
  type Effect,
  fail,
  flatMap,
  gen,
  map,
  mapError,
  SchemaArray,
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
  readonly releaseStatus: 'absent' | 'draft' | 'prerelease' | 'published';
  readonly tagSha: string | null;
};

const HTTP_NOT_FOUND = 404;
const HTTP_OK = 200;
const MAX_TAG_DEPTH = 8;
const MAX_RELEASE_PAGES = 100;
const RELEASES_PER_PAGE = 100;
const TAG_NAME_FIELD = 'tag_name';

const apiObjectSchema = Struct({
  object: Struct({ sha: SchemaString, type: SchemaString }),
});

const releaseSchema = Struct({
  draft: SchemaBoolean,
  prerelease: SchemaBoolean,
  [TAG_NAME_FIELD]: SchemaString,
});
const releaseListSchema = SchemaArray(releaseSchema);

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

const findRelease = (client: GithubClient, tag: string) =>
  gen(function* () {
    for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
      const response = yield* get(
        client,
        `/repos/${client.repo}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`,
      );
      if (response.status !== HTTP_OK) {
        return yield* fail(
          new GithubApiError({
            message: `Listing GitHub releases page ${page}: HTTP ${response.status} ${apiMessage(response)}`,
          }),
        );
      }
      const releases = yield* decodeUnknown(releaseListSchema)(
        response.body,
      ).pipe(
        mapError(
          () =>
            new GithubApiError({
              message: `GitHub release list page ${page} returned invalid release state`,
            }),
        ),
      );
      const exact = releases.find((release) => release[TAG_NAME_FIELD] === tag);
      if (exact !== undefined) {
        return exact;
      }
      if (releases.length < RELEASES_PER_PAGE) {
        return null;
      }
    }
    return yield* fail(
      new GithubApiError({
        message: `GitHub release listing exceeded ${MAX_RELEASE_PAGES} pages`,
      }),
    );
  });

export const loadGithubState = (client: GithubClient, tag: string) =>
  gen(function* () {
    const release = yield* findRelease(client, tag);
    let releaseStatus: GithubState['releaseStatus'] = 'absent';
    if (release !== null) {
      releaseStatus = 'published';
      if (release.prerelease) {
        releaseStatus = 'prerelease';
      } else if (release.draft) {
        releaseStatus = 'draft';
      }
    }
    const tagSha = yield* loadTagSha(client, tag);
    return { releaseStatus, tagSha } satisfies GithubState;
  });
