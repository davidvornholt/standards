import { effectTry, flatMap, succeed, tryPromise } from './release-effect';
import { ReleasePackageError } from './release-package-error';
import { verifyPackedArtifactBytes } from './release-package-identity';
import { rewriteReleaseTar } from './release-package-tar';
import { file, nodeGunzipSync, nodeGzipSync, write } from './release-runtime';

const GZIP_LEVEL = 9;
const GZIP_MTIME = 0;

const rewriteError = (operation: string, cause: unknown) =>
  new ReleasePackageError({
    message: `Packing release artifact failed while ${operation}: ${String(cause)}`,
  });

export const rewritePackedArtifact = (input: {
  readonly artifact: string;
  readonly expectedSha: string;
}) =>
  tryPromise({
    try: () => file(input.artifact).arrayBuffer(),
    catch: (cause) => rewriteError('reading the packed artifact', cause),
  }).pipe(
    flatMap((compressed) =>
      effectTry({
        try: () => nodeGunzipSync(new Uint8Array(compressed)),
        catch: (cause) =>
          rewriteError('decompressing the packed artifact', cause),
      }),
    ),
    flatMap((archive) => rewriteReleaseTar(archive, input.expectedSha)),
    flatMap((archive) =>
      effectTry({
        try: () =>
          nodeGzipSync(archive, { level: GZIP_LEVEL, mtime: GZIP_MTIME }),
        catch: (cause) =>
          rewriteError('compressing the source-bound artifact', cause),
      }),
    ),
    flatMap((compressed) =>
      tryPromise({
        try: () => write(input.artifact, compressed),
        catch: (cause) =>
          rewriteError('writing the source-bound artifact', cause),
      }),
    ),
    flatMap(() =>
      tryPromise({
        try: () => file(input.artifact).arrayBuffer(),
        catch: (cause) => rewriteError('reading the rewritten artifact', cause),
      }),
    ),
    flatMap((compressed) =>
      verifyPackedArtifactBytes({
        bytes: new Uint8Array(compressed),
        expectedSha: input.expectedSha,
      }),
    ),
    flatMap(() => succeed(input.artifact)),
  );
