import { resolve } from 'node:path';
import type { DevEnvMutation } from './dev-env-destination';

export const duplicateDestinationProblems = (
  root: string,
  mutations: ReadonlyArray<DevEnvMutation>,
): ReadonlyArray<string> => {
  const rawDuplicates = mutations.flatMap((mutation, index) => {
    const firstIndex = mutations.findIndex(({ rel }) => rel === mutation.rel);
    return firstIndex < index
      ? [`${mutation.rel} is declared more than once`]
      : [];
  });
  const resolved = mutations.map((mutation) => ({
    mutation,
    dest: resolve(root, mutation.rel),
  }));
  const normalizedDuplicates = resolved.flatMap((destination, index) => {
    const firstIndex = resolved.findIndex(
      ({ dest }) => dest === destination.dest,
    );
    const first = resolved[firstIndex];
    return firstIndex < index &&
      first !== undefined &&
      first.mutation.rel !== destination.mutation.rel
      ? [
          `${destination.mutation.rel} resolves to the same destination as ${first.mutation.rel}`,
        ]
      : [];
  });
  return [...rawDuplicates, ...normalizedDuplicates];
};
