import { TaggedError } from 'effect/Data';

export class ArtifactIdentityError extends TaggedError(
  'ArtifactIdentityError',
)<{ readonly message: string }> {}
