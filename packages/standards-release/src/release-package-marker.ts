import type { Effect } from './release-effect';
import {
  causeSequential,
  exit,
  failCause,
  gen,
  map,
  tryPromise,
  uninterruptibleMask,
} from './release-effect';
import { ReleasePackageError } from './release-package-error';
import { file, nodeWriteFile } from './release-runtime';

type MarkerEffect<A> = Effect<A, ReleasePackageError>;

export type MarkerOperations = {
  readonly create: (marker: string, contents: string) => MarkerEffect<string>;
  readonly remove: (marker: string) => MarkerEffect<void>;
};

const markerError = (operation: string, cause: unknown) =>
  new ReleasePackageError({
    message: `Packing release artifact failed while ${operation}: ${String(cause)}`,
  });

export const markerOperations: MarkerOperations = {
  create: (marker, contents) =>
    tryPromise({
      try: () => nodeWriteFile(marker, contents, { flag: 'wx' }),
      catch: (cause) => markerError('creating the source marker', cause),
    }).pipe(map(() => marker)),
  remove: (marker) =>
    tryPromise({
      try: () => file(marker).delete(),
      catch: (cause) => markerError('cleaning the source marker', cause),
    }),
};

// Effect's standard bracket requires an infallible finalizer. This variant keeps marker cleanup failures typed while retaining uninterruptible acquisition and release.
const acquireUseReleaseTyped = <A>(
  acquire: MarkerEffect<string>,
  use: (marker: string) => MarkerEffect<A>,
  release: (marker: string) => MarkerEffect<void>,
): MarkerEffect<A> =>
  uninterruptibleMask((restore) =>
    gen(function* () {
      const marker = yield* acquire;
      const operationResult = yield* exit(restore(use(marker)));
      const cleanupResult = yield* exit(release(marker));
      if (cleanupResult._tag === 'Failure') {
        return yield* failCause(
          operationResult._tag === 'Failure'
            ? causeSequential(operationResult.cause, cleanupResult.cause)
            : cleanupResult.cause,
        );
      }
      if (operationResult._tag === 'Failure') {
        return yield* failCause(operationResult.cause);
      }
      return operationResult.value;
    }),
  );

export const withGeneratedMarkerOperations = <A>(
  marker: string,
  contents: string,
  use: (marker: string) => MarkerEffect<A>,
  operations: MarkerOperations,
) =>
  acquireUseReleaseTyped(
    operations.create(marker, contents),
    use,
    operations.remove,
  );

export const withGeneratedMarker = <A>(
  marker: string,
  contents: string,
  use: (marker: string) => MarkerEffect<A>,
) => withGeneratedMarkerOperations(marker, contents, use, markerOperations);
