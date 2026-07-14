import { TaggedError } from 'effect/Data';

export class ReleaseReproductionError extends TaggedError(
  'ReleaseReproductionError',
)<{ readonly message: string }> {}
