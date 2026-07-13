import { TaggedError } from 'effect/Data';

export class GithubStateError extends TaggedError('GithubStateError')<{
  readonly message: string;
}> {}
