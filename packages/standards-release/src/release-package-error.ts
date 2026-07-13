import { TaggedError } from 'effect/Data';

export class ReleasePackageError extends TaggedError('ReleasePackageError')<{
  readonly message: string;
}> {}
