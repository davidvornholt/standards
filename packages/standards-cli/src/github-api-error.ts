import { TaggedError } from 'effect/Data';

export class GithubApiError extends TaggedError('GithubApiError')<{
  readonly message: string;
}> {}
