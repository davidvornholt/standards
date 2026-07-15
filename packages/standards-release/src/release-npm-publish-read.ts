import {
  type Effect,
  fail,
  flatMap,
  succeed,
  tryPromise,
} from './release-effect';
import { stagedArtifactFailure } from './release-npm-publish-error';
import type { RuntimeFileHandle } from './release-runtime';

const readRange = (
  handle: RuntimeFileHandle,
  bytes: Uint8Array,
  offset: number,
): Effect<Uint8Array, ReturnType<typeof stagedArtifactFailure>> =>
  offset === bytes.byteLength
    ? succeed(bytes)
    : tryPromise({
        try: () =>
          handle.read(bytes, offset, bytes.byteLength - offset, offset),
        catch: (cause) =>
          stagedArtifactFailure('reading the staged artifact', cause),
      }).pipe(
        flatMap((result) =>
          result.bytesRead === 0
            ? fail(
                stagedArtifactFailure(
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
    catch: (cause) =>
      stagedArtifactFailure('statting the staged artifact', cause),
  }).pipe(flatMap((stats) => readRange(handle, new Uint8Array(stats.size), 0)));
