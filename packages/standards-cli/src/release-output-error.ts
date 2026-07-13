import { TaggedError } from 'effect/Data';

export class ReleaseOutputError extends TaggedError('ReleaseOutputError')<{
  readonly message: string;
}> {}
