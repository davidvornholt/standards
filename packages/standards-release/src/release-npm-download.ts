import { NpmRegistryError } from './npm-registry-error';
import { fail, gen, map, tryPromise } from './release-effect';

export type ReleaseFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const HTTP_OK = 200;

export const downloadPublishedArtifact = (
  fetcher: ReleaseFetcher,
  tarball: string,
) =>
  gen(function* () {
    const response = yield* tryPromise({
      try: () =>
        fetcher(tarball, { headers: { accept: 'application/octet-stream' } }),
      catch: (cause) =>
        new NpmRegistryError({
          message: `Downloading npm artifact failed: ${String(cause)}`,
        }),
    });
    if (response.status !== HTTP_OK) {
      return yield* fail(
        new NpmRegistryError({
          message: `Downloading npm artifact failed with HTTP ${response.status}`,
        }),
      );
    }
    return yield* tryPromise({
      try: () => response.arrayBuffer(),
      catch: (cause) =>
        new NpmRegistryError({
          message: `Reading npm artifact failed: ${String(cause)}`,
        }),
    }).pipe(map((bytes) => new Uint8Array(bytes)));
  });
