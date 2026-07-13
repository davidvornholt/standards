import { ArtifactIdentityError } from './artifact-identity-error';
import { NpmRegistryError } from './npm-registry-error';
import {
  decodeUnknown,
  fail,
  gen,
  map,
  mapError,
  optional,
  SchemaRecord,
  SchemaString,
  Struct,
  tryPromise,
  Unknown,
} from './release-effect';
import { BunCryptoHasher, file } from './release-runtime';
import {
  decideRelease,
  type ReleasePlan,
  verifyArtifactIdentity,
} from './release-state';

export type ReleaseFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type NpmInspection = ReleasePlan & { readonly integrity: string };
type NpmState = {
  readonly gitHead: string | null;
  readonly integrity: string | null;
  readonly latest: string | null;
  readonly versionExists: boolean;
};

const HTTP_NOT_FOUND = 404;
const HTTP_OK = 200;

const packageMetadataSchema = Struct({
  'dist-tags': Struct({ latest: SchemaString }),
  versions: SchemaRecord({ key: SchemaString, value: Unknown }),
});

const declaredVersionSchema = Struct({
  dist: Struct({ integrity: optional(SchemaString) }),
  gitHead: optional(SchemaString),
});

const decodePackageMetadata = (body: unknown) =>
  decodeUnknown(packageMetadataSchema)(body).pipe(
    mapError(
      () =>
        new NpmRegistryError({
          message:
            'npm metadata requires string dist-tags.latest and a versions object',
        }),
    ),
  );

const parseMetadata = (body: unknown, version: string) =>
  gen(function* () {
    const metadata = yield* decodePackageMetadata(body);
    const declared = metadata.versions[version];
    if (declared === undefined) {
      return {
        gitHead: null,
        integrity: null,
        latest: metadata['dist-tags'].latest,
        versionExists: false,
      } satisfies NpmState;
    }
    const identity = yield* decodeUnknown(declaredVersionSchema)(declared).pipe(
      mapError(
        () =>
          new NpmRegistryError({
            message: `npm metadata for ${version} requires dist metadata and a string gitHead when present`,
          }),
      ),
    );
    return {
      gitHead: identity.gitHead ?? null,
      integrity: identity.dist.integrity ?? null,
      latest: metadata['dist-tags'].latest,
      versionExists: true,
    } satisfies NpmState;
  });

const loadNpmState = (input: {
  readonly fetcher: ReleaseFetcher;
  readonly name: string;
  readonly registryUrl: string;
  readonly version: string;
}) =>
  gen(function* () {
    const response = yield* tryPromise({
      try: () =>
        input.fetcher(
          `${input.registryUrl}/${encodeURIComponent(input.name)}`,
          {
            headers: { accept: 'application/json' },
          },
        ),
      catch: (cause) =>
        new NpmRegistryError({
          message: `Reading npm metadata failed: ${String(cause)}`,
        }),
    });
    if (response.status === HTTP_NOT_FOUND) {
      return {
        gitHead: null,
        integrity: null,
        latest: null,
        versionExists: false,
      } satisfies NpmState;
    }
    if (response.status !== HTTP_OK) {
      return yield* fail(
        new NpmRegistryError({
          message: `Reading npm metadata failed with HTTP ${response.status}`,
        }),
      );
    }
    const body = yield* tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: () =>
        new NpmRegistryError({ message: 'npm returned invalid JSON metadata' }),
    });
    return yield* parseMetadata(body, input.version);
  });

export const npmIntegrity = (artifact: string) =>
  tryPromise({
    try: () => file(artifact).arrayBuffer(),
    catch: (cause) =>
      new ArtifactIdentityError({
        message: `Reading package artifact failed: ${String(cause)}`,
      }),
  }).pipe(
    map((bytes) => {
      const digest = new BunCryptoHasher('sha512')
        .update(bytes)
        .digest('base64');
      return `sha512-${digest}`;
    }),
  );

export const inspectNpmRelease = (input: {
  readonly artifact: string;
  readonly expectedSha: string;
  readonly fetcher?: ReleaseFetcher;
  readonly name: string;
  readonly parentVersion: string | null;
  readonly registryUrl?: string;
  readonly version: string;
}) =>
  gen(function* () {
    const expectedIntegrity = yield* npmIntegrity(input.artifact);
    const state = yield* loadNpmState({
      fetcher: input.fetcher ?? fetch,
      name: input.name,
      registryUrl: input.registryUrl ?? 'https://registry.npmjs.org',
      version: input.version,
    });
    yield* verifyArtifactIdentity({
      expectedIntegrity,
      expectedSha: input.expectedSha,
      npmGitHead: state.gitHead,
      npmIntegrity: state.integrity,
      npmVersionExists: state.versionExists,
    });
    const plan = yield* decideRelease({
      npmLatest: state.latest,
      npmVersionExists: state.versionExists,
      parentVersion: input.parentVersion,
      version: input.version,
    });
    return { ...plan, integrity: expectedIntegrity } satisfies NpmInspection;
  });
