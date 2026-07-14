import { ArtifactIdentityError } from './artifact-identity-error';
import { NpmRegistryError } from './npm-registry-error';
import { authenticatePublishedArtifact } from './release-artifact-reproduction';
import {
  decodeUnknown,
  fail,
  gen,
  map,
  mapError,
  SchemaRecord,
  SchemaString,
  Struct,
  tryPromise,
  Unknown,
} from './release-effect';
import {
  downloadPublishedArtifact,
  type ReleaseFetcher,
} from './release-npm-download';
import {
  inspectPackedArtifactBytes,
  packedArtifactIntegrity,
  readPackedArtifact,
} from './release-package-identity';
import { decideRelease, type ReleasePlan } from './release-state';

export type { ReleaseFetcher } from './release-npm-download';

type NpmInspection = ReleasePlan & { readonly releaseSha: string };
type PublishedVersion = {
  readonly integrity: string;
  readonly tarball: string;
};
type NpmState = {
  readonly latest: string | null;
  readonly published: PublishedVersion | null;
};

const HTTP_NOT_FOUND = 404;
const HTTP_OK = 200;

const packageMetadataSchema = Struct({
  'dist-tags': Struct({ latest: SchemaString }),
  versions: SchemaRecord({ key: SchemaString, value: Unknown }),
});

const publishedVersionSchema = Struct({
  dist: Struct({ integrity: SchemaString, tarball: SchemaString }),
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
        latest: metadata['dist-tags'].latest,
        published: null,
      } satisfies NpmState;
    }
    const identity = yield* decodeUnknown(publishedVersionSchema)(
      declared,
    ).pipe(
      mapError(
        () =>
          new NpmRegistryError({
            message: `npm metadata for ${version} requires string dist.integrity and dist.tarball`,
          }),
      ),
    );
    return {
      latest: metadata['dist-tags'].latest,
      published: {
        integrity: identity.dist.integrity,
        tarball: identity.dist.tarball,
      },
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
          { headers: { accept: 'application/json' } },
        ),
      catch: (cause) =>
        new NpmRegistryError({
          message: `Reading npm metadata failed: ${String(cause)}`,
        }),
    });
    if (response.status === HTTP_NOT_FOUND) {
      return { latest: null, published: null } satisfies NpmState;
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
  readPackedArtifact(artifact).pipe(map(packedArtifactIntegrity));

export const inspectNpmRelease = (input: {
  readonly currentSha: string;
  readonly fetcher?: ReleaseFetcher;
  readonly name: string;
  readonly registryUrl?: string;
  readonly repositoryPath: string;
  readonly temporaryDirectory: string;
  readonly version: string;
}) =>
  gen(function* () {
    const fetcher = input.fetcher ?? fetch;
    const state = yield* loadNpmState({
      fetcher,
      name: input.name,
      registryUrl: input.registryUrl ?? 'https://registry.npmjs.org',
      version: input.version,
    });
    const plan = yield* decideRelease({
      npmLatest: state.latest,
      npmVersionExists: state.published !== null,
      version: input.version,
    });
    if (state.published === null) {
      return {
        ...plan,
        releaseSha: input.currentSha,
      } satisfies NpmInspection;
    }
    const bytes = yield* downloadPublishedArtifact(
      fetcher,
      state.published.tarball,
    );
    const identity = yield* inspectPackedArtifactBytes({
      bytes,
      expectedIntegrity: state.published.integrity,
    });
    if (identity.name !== input.name || identity.version !== input.version) {
      return yield* fail(
        new ArtifactIdentityError({
          message: `Package artifact declares ${identity.name}@${identity.version}, expected ${input.name}@${input.version}`,
        }),
      );
    }
    const releaseSha = yield* authenticatePublishedArtifact({
      candidateSha: identity.sha,
      currentSha: input.currentSha,
      downloadedBytes: bytes,
      expectedIntegrity: state.published.integrity,
      repositoryPath: input.repositoryPath,
      temporaryDirectory: input.temporaryDirectory,
    });
    return {
      ...plan,
      releaseSha,
    } satisfies NpmInspection;
  });
