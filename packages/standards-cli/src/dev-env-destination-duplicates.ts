import { resolve } from 'node:path';
import type { DevEnvWrite } from './dev-env-destination';

export const duplicateDestinationProblems = (
  root: string,
  writes: ReadonlyArray<DevEnvWrite>,
): ReadonlyArray<string> => {
  const rawDuplicates = writes.flatMap((write, index) => {
    const firstIndex = writes.findIndex(({ rel }) => rel === write.rel);
    return firstIndex < index
      ? [`${write.rel} is declared more than once`]
      : [];
  });
  const resolved = writes.map((write) => ({
    write,
    dest: resolve(root, write.rel),
  }));
  const normalizedDuplicates = resolved.flatMap((destination, index) => {
    const firstIndex = resolved.findIndex(
      ({ dest }) => dest === destination.dest,
    );
    const first = resolved[firstIndex];
    return firstIndex < index &&
      first !== undefined &&
      first.write.rel !== destination.write.rel
      ? [
          `${destination.write.rel} resolves to the same destination as ${first.write.rel}`,
        ]
      : [];
  });
  return [...rawDuplicates, ...normalizedDuplicates];
};
