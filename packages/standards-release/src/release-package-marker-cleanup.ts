import {
  fail as causeFailure,
  sequential as causeSequential,
} from 'effect/Cause';
import { TaggedError } from 'effect/Data';
import type { Effect } from './release-effect';
import {
  either,
  exit,
  fail,
  failCause,
  gen,
  isLeft,
  mapError,
  tryPromise,
} from './release-effect';
import { ReleasePackageError } from './release-package-error';
import {
  nodeLink,
  nodeLstat,
  nodeMkdtemp,
  nodeRename,
  nodeRmdir,
  nodeUnlink,
} from './release-runtime';

export type MarkerIdentity = {
  readonly device: string;
  readonly inode: string;
};

class MarkerFilesystemError extends TaggedError('MarkerFilesystemError')<{
  readonly cause: unknown;
  readonly operation: string;
}> {}

const filesystem = <A>(operation: string, action: () => Promise<A>) =>
  tryPromise({
    try: action,
    catch: (cause) => new MarkerFilesystemError({ cause, operation }),
  });

const errorCode = (error: MarkerFilesystemError): string | null => {
  const { cause } = error;
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) {
    return null;
  }
  const { code } = cause;
  return typeof code === 'string' ? code : null;
};

const releaseError = (error: MarkerFilesystemError, recoveryPath?: string) =>
  new ReleasePackageError({
    message: `Packing release artifact failed while ${error.operation}: ${String(error.cause)}${recoveryPath === undefined ? '' : `; preserved entry at ${recoveryPath}`}`,
  });

const releaseFilesystem = <A>(effect: Effect<A, MarkerFilesystemError>) =>
  effect.pipe(mapError(releaseError));

const removeOwnedQuarantine = (entry: string, directory: string) =>
  gen(function* () {
    const unlinkResult = yield* exit(
      releaseFilesystem(
        filesystem('deleting the verified source marker', () =>
          nodeUnlink(entry),
        ),
      ),
    );
    const directoryResult = yield* exit(
      releaseFilesystem(
        filesystem('removing the source marker quarantine', () =>
          nodeRmdir(directory),
        ),
      ),
    );
    if (unlinkResult._tag === 'Failure') {
      return yield* failCause(
        directoryResult._tag === 'Failure'
          ? causeSequential(unlinkResult.cause, directoryResult.cause)
          : unlinkResult.cause,
      );
    }
    if (directoryResult._tag === 'Failure') {
      return yield* failCause(directoryResult.cause);
    }
  });

const restoreReplacement = (marker: string, entry: string) =>
  gen(function* () {
    const restoreResult = yield* either(
      filesystem('restoring a caller-owned source marker', () =>
        nodeLink(entry, marker),
      ),
    );
    if (isLeft(restoreResult)) {
      return yield* fail(releaseError(restoreResult.left, entry));
    }
    return yield* fail(
      new ReleasePackageError({
        message: `Packing release artifact preserved a caller-owned source marker at ${marker} and recovery link ${entry}; remove the recovery link after verifying the marker`,
      }),
    );
  });

export const removeOwnedMarker = (marker: string, identity: MarkerIdentity) =>
  gen(function* () {
    const directory = yield* releaseFilesystem(
      filesystem('creating the source marker quarantine', () =>
        nodeMkdtemp(`${marker}.cleanup-`),
      ),
    );
    const entry = `${directory}/marker`;
    const moveResult = yield* either(
      filesystem('quarantining the source marker', () =>
        nodeRename(marker, entry),
      ),
    );
    if (isLeft(moveResult)) {
      const directoryResult = yield* exit(
        releaseFilesystem(
          filesystem('removing the empty source marker quarantine', () =>
            nodeRmdir(directory),
          ),
        ),
      );
      if (errorCode(moveResult.left) === 'ENOENT') {
        return directoryResult._tag === 'Failure'
          ? yield* failCause(directoryResult.cause)
          : undefined;
      }
      const moveCause = causeFailure(releaseError(moveResult.left));
      return yield* failCause(
        directoryResult._tag === 'Failure'
          ? causeSequential(moveCause, directoryResult.cause)
          : moveCause,
      );
    }
    const quarantined = yield* filesystem(
      'identifying the quarantined source marker',
      () => nodeLstat(entry, { bigint: true }),
    ).pipe(mapError((error) => releaseError(error, entry)));
    const quarantinedIdentity = {
      device: quarantined.dev.toString(),
      inode: quarantined.ino.toString(),
    };
    if (
      quarantinedIdentity.device === identity.device &&
      quarantinedIdentity.inode === identity.inode
    ) {
      return yield* removeOwnedQuarantine(entry, directory);
    }
    return yield* restoreReplacement(marker, entry);
  });
