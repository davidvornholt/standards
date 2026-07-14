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
import {
  type MarkerIdentity,
  removeOwnedMarker,
} from './release-package-marker-cleanup';
import { nodeOpenFile } from './release-runtime';

type MarkerEffect<A> = Effect<A, ReleasePackageError>;
type MarkerHandle = Awaited<ReturnType<typeof nodeOpenFile>>;

export type MarkerOwnership = {
  readonly handle: MarkerHandle;
  readonly marker: string;
};

export type MarkerOperations = {
  readonly close: (ownership: MarkerOwnership) => MarkerEffect<void>;
  readonly identify: (
    ownership: MarkerOwnership,
  ) => MarkerEffect<MarkerIdentity>;
  readonly open: (marker: string) => MarkerEffect<MarkerOwnership>;
  readonly remove: (
    ownership: MarkerOwnership,
    identity: MarkerIdentity,
  ) => MarkerEffect<void>;
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
  identify: (ownership) =>
    tryPromise({
      try: () => ownership.handle.stat({ bigint: true }),
      catch: (cause) => markerError('identifying the source marker', cause),
    }).pipe(
      map((identity) => ({
        device: identity.dev.toString(),
        inode: identity.ino.toString(),
      })),
    ),
  open: (marker) =>
    tryPromise({
      try: () => nodeOpenFile(marker, 'wx'),
      catch: (cause) => markerError('opening the source marker', cause),
    }).pipe(map((handle) => ({ handle, marker }))),
  remove: (ownership, identity) =>
    removeOwnedMarker(ownership.marker, identity),
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
  identityResult: Exit<MarkerIdentity, ReleasePackageError>,
  writeResult: Exit<void, ReleasePackageError>,
): Cause<ReleasePackageError> | null => {
  let combined: Cause<ReleasePackageError> | null =
    identityResult._tag === 'Failure' ? identityResult.cause : null;
  if (writeResult._tag === 'Failure') {
    combined = appendCause(combined, writeResult.cause);
  }
  return combined;
};

const cleanupPreparationFailure = (
  cause: Cause<ReleasePackageError>,
  ownership: MarkerOwnership,
  identityResult: Exit<MarkerIdentity, ReleasePackageError>,
  operations: MarkerOperations,
): MarkerEffect<never> =>
  gen(function* () {
    const cleanupResult = yield* exit(
      identityResult._tag === 'Failure'
        ? succeed(undefined)
        : operations.remove(ownership, identityResult.value),
    );
    const closeResult = yield* exit(operations.close(ownership));
    let combined = cause;
    if (cleanupResult._tag === 'Failure') {
      combined = causeSequential(combined, cleanupResult.cause);
    }
    if (closeResult._tag === 'Failure') {
      combined = causeSequential(combined, closeResult.cause);
    }
    return yield* failCause(combined);
  });

const completeOperation = <A>(
  operationResult: Exit<A, ReleasePackageError>,
  cleanupResult: Exit<void, ReleasePackageError>,
  closeResult: Exit<void, ReleasePackageError>,
): MarkerEffect<A> => {
  let combined: Cause<ReleasePackageError> | null =
    operationResult._tag === 'Failure' ? operationResult.cause : null;
  if (cleanupResult._tag === 'Failure') {
    combined = appendCause(combined, cleanupResult.cause);
  }
  if (closeResult._tag === 'Failure') {
    combined = appendCause(combined, closeResult.cause);
  }
  if (combined !== null) {
    return failCause(combined);
  }
  return operationResult._tag === 'Failure'
    ? failCause(operationResult.cause)
    : succeed(operationResult.value);
};

// Effect's standard bracket requires an infallible finalizer. This variant retains typed identity, write, cleanup, and close failures while holding ownership through cleanup.
const acquireUseReleaseTyped = <A>(
  marker: string,
  contents: string,
  use: (marker: string) => MarkerEffect<A>,
  operations: MarkerOperations,
): MarkerEffect<A> =>
  uninterruptibleMask((restore) =>
    gen(function* () {
      const ownership = yield* operations.open(marker);
      const identityResult = yield* exit(operations.identify(ownership));
      const writeResult = yield* exit(
        identityResult._tag === 'Failure'
          ? succeed(undefined)
          : operations.write(ownership, contents),
      );
      const preparationCause = preparationFailureCause(
        identityResult,
        writeResult,
      );
      if (preparationCause !== null) {
        return yield* cleanupPreparationFailure(
          preparationCause,
          ownership,
          identityResult,
          operations,
        );
      }
      if (identityResult._tag === 'Failure') {
        return yield* failCause(identityResult.cause);
      }
      const operationResult = yield* exit(restore(use(marker)));
      const cleanupResult = yield* exit(
        operations.remove(ownership, identityResult.value),
      );
      const closeResult = yield* exit(operations.close(ownership));
      return yield* completeOperation(
        operationResult,
        cleanupResult,
        closeResult,
      );
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
