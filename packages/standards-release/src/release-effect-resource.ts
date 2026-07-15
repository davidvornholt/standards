import { isFailure } from 'effect/Exit';
import {
  type Effect,
  exit,
  failCause,
  gen,
  uninterruptibleMask,
} from './release-effect';

export const bracketEffect = <
  A,
  AcquireError,
  B,
  UseError,
  ReleaseError,
>(input: {
  readonly acquire: Effect<A, AcquireError>;
  readonly release: (resource: A) => Effect<void, ReleaseError>;
  readonly use: (resource: A) => Effect<B, UseError>;
}) =>
  uninterruptibleMask((restore) =>
    gen(function* () {
      const resource = yield* input.acquire;
      const operationExit = yield* exit(restore(input.use(resource)));
      const cleanupExit = yield* exit(input.release(resource));
      if (isFailure(cleanupExit)) {
        return yield* failCause(cleanupExit.cause);
      }
      if (isFailure(operationExit)) {
        return yield* failCause(operationExit.cause);
      }
      return operationExit.value;
    }),
  );
