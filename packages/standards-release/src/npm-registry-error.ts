import { TaggedError } from 'effect/Data';

export class NpmRegistryError extends TaggedError('NpmRegistryError')<{
  readonly message: string;
}> {}
