import { TaggedError } from 'effect/Data';

export class ReleaseInputError extends TaggedError('ReleaseInputError')<{
  readonly message: string;
}> {}
