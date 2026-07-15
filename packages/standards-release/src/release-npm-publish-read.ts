import { ArtifactIdentityError } from './artifact-identity-error';
import {
  type Effect,
  fail,
  flatMap,
  succeed,
  tryPromise,
} from './release-effect';
import type { RuntimeFileHandle } from './release-runtime';

const readFailure = (operation: string, cause: unknown) =>
  new ArtifactIdentityError({
    message: `Preparing package artifact failed while ${operation}: ${String(cause)}`,
  });

const readRange = (
  handle: RuntimeFileHandle,
  bytes: Uint8Array,
  offset: number,
): Effect<Uint8Array, ArtifactIdentityError> =>
  offset === bytes.byteLength
    ? succeed(bytes)
    : tryPromise({
        try: () =>
          handle.read(bytes, offset, bytes.byteLength - offset, offset),
        catch: (cause) => readFailure('reading the staged artifact', cause),
      }).pipe(
        flatMap((result) =>
          result.bytesRead === 0
            ? fail(
                readFailure(
                  'reading the staged artifact',
                  'unexpected end of file',
                ),
              )
            : readRange(handle, bytes, offset + result.bytesRead),
        ),
      );

export const readStagedArtifact = (handle: RuntimeFileHandle) =>
  tryPromise({
    try: () => handle.stat(),
    catch: (cause) => readFailure('statting the staged artifact', cause),
  }).pipe(flatMap((stats) => readRange(handle, new Uint8Array(stats.size), 0)));
