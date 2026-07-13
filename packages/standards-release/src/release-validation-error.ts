import { TaggedError } from 'effect/Data';

export class ReleaseValidationError extends TaggedError(
  'ReleaseValidationError',
)<{ readonly message: string }> {}
