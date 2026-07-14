import type { Cause } from 'effect/Cause';
import type { Exit } from 'effect/Exit';
import type { Effect } from './release-effect';
import {
  causeSequential,
  exit,
  failCause,
  gen,
  map,
  succeed,
  tryPromise,
  uninterruptibleMask,
} from './release-effect';
import { ReleasePackageError } from './release-package-error';
import { file, nodeOpenFile } from './release-runtime';

type MarkerEffect<A> = Effect<A, ReleasePackageError>;
type MarkerHandle = Awaited<ReturnType<typeof nodeOpenFile>>;

export type MarkerOwnership = {
  readonly handle: MarkerHandle;
  readonly marker: string;
};

export type MarkerOperations = {
  readonly close: (ownership: MarkerOwnership) => MarkerEffect<void>;
  readonly open: (marker: string) => MarkerEffect<MarkerOwnership>;
  readonly remove: (ownership: MarkerOwnership) => MarkerEffect<void>;
  readonly write: (
    ownership: MarkerOwnership,
    contents: string,
  ) => MarkerEffect<void>;
};

const markerError = (operation: string, cause: unknown) =>
  new ReleasePackageError({
    message: `Packing release artifact failed while ${operation}: ${String(cause)}`,
  });

export const markerOperations: MarkerOperations = {
  close: (ownership) =>
    tryPromise({
      try: () => ownership.handle.close(),
      catch: (cause) => markerError('closing the source marker', cause),
    }),
  open: (marker) =>
    tryPromise({
      try: () => nodeOpenFile(marker, 'wx'),
      catch: (cause) => markerError('opening the source marker', cause),
    }).pipe(map((handle) => ({ handle, marker }))),
  remove: (ownership) =>
    tryPromise({
      try: () => file(ownership.marker).delete(),
      catch: (cause) => markerError('cleaning the source marker', cause),
    }),
  write: (ownership, contents) =>
    tryPromise({
      try: () => ownership.handle.writeFile(contents),
      catch: (cause) => markerError('writing the source marker', cause),
    }),
};

const appendCause = (
  first: Cause<ReleasePackageError> | null,
  second: Cause<ReleasePackageError>,
): Cause<ReleasePackageError> =>
  first === null ? second : causeSequential(first, second);

const preparationFailureCause = (
  writeResult: Exit<void, ReleasePackageError>,
  closeResult: Exit<void, ReleasePackageError>,
): Cause<ReleasePackageError> | null => {
  let combined: Cause<ReleasePackageError> | null =
    writeResult._tag === 'Failure' ? writeResult.cause : null;
  if (closeResult._tag === 'Failure') {
    combined = appendCause(combined, closeResult.cause);
  }
  return combined;
};

const cleanupPreparationFailure = (
  cause: Cause<ReleasePackageError>,
  ownership: MarkerOwnership,
  operations: MarkerOperations,
): MarkerEffect<never> =>
  gen(function* () {
    const cleanupResult = yield* exit(operations.remove(ownership));
    return yield* failCause(
      cleanupResult._tag === 'Failure'
        ? causeSequential(cause, cleanupResult.cause)
        : cause,
    );
  });

const completeOperation = <A>(
  operationResult: Exit<A, ReleasePackageError>,
  cleanupResult: Exit<void, ReleasePackageError>,
): MarkerEffect<A> => {
  if (cleanupResult._tag === 'Failure') {
    return failCause(
      operationResult._tag === 'Failure'
        ? causeSequential(operationResult.cause, cleanupResult.cause)
        : cleanupResult.cause,
    );
  }
  return operationResult._tag === 'Failure'
    ? failCause(operationResult.cause)
    : succeed(operationResult.value);
};

// Effect's standard bracket requires an infallible finalizer. This variant retains typed write, close, and cleanup failures after exclusive-open ownership is established.
const acquireUseReleaseTyped = <A>(
  marker: string,
  contents: string,
  use: (marker: string) => MarkerEffect<A>,
  operations: MarkerOperations,
): MarkerEffect<A> =>
  uninterruptibleMask((restore) =>
    gen(function* () {
      const ownership = yield* operations.open(marker);
      const writeResult = yield* exit(operations.write(ownership, contents));
      const closeResult = yield* exit(operations.close(ownership));
      const preparationCause = preparationFailureCause(
        writeResult,
        closeResult,
      );
      if (preparationCause !== null) {
        return yield* cleanupPreparationFailure(
          preparationCause,
          ownership,
          operations,
        );
      }
      const operationResult = yield* exit(restore(use(marker)));
      const cleanupResult = yield* exit(operations.remove(ownership));
      return yield* completeOperation(operationResult, cleanupResult);
    }),
  );

export const withGeneratedMarkerOperations = <A>(
  marker: string,
  contents: string,
  use: (marker: string) => MarkerEffect<A>,
  operations: MarkerOperations,
) => acquireUseReleaseTyped(marker, contents, use, operations);

export const withGeneratedMarker = <A>(
  marker: string,
  contents: string,
  use: (marker: string) => MarkerEffect<A>,
) => withGeneratedMarkerOperations(marker, contents, use, markerOperations);
