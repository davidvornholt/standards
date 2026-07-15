import { inspectClassifierSource } from './release-classifier-closure-test-parser';

export type ReadClassifierModule = (module: URL) => Promise<string>;

const ALLOWED_BUILTINS: ReadonlySet<string> = new Set([
  'node:fs/promises',
  'node:process',
]);

export const forbiddenClassifierSpecifiers = (
  sources: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  sources
    .flatMap((source) => inspectClassifierSource(source).specifiers)
    .filter(
      (specifier) =>
        !(specifier.startsWith('.') || ALLOWED_BUILTINS.has(specifier)),
    );

export const readClassifierModuleClosure = async (
  module: URL,
  visited: Set<string>,
  readModule: ReadClassifierModule,
): Promise<ReadonlyArray<string>> => {
  if (visited.has(module.href)) {
    return [];
  }
  visited.add(module.href);
  const source = await readModule(module);
  const inspection = inspectClassifierSource(source);
  if (inspection.problems.length > 0) {
    throw new Error(inspection.problems.join('\n'));
  }
  const descendants = await Promise.all(
    inspection.specifiers
      .filter((specifier) => specifier.startsWith('.'))
      .map((specifier) =>
        readClassifierModuleClosure(
          new URL(
            specifier.endsWith('.ts') ? specifier : `${specifier}.ts`,
            module,
          ),
          visited,
          readModule,
        ),
      ),
  );
  return [source, ...descendants.flat()];
};
