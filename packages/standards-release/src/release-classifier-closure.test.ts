import { expect, it } from 'bun:test';
import { file } from './release-runtime';

const classifier = await file(
  `${import.meta.dir}/../scripts/classify-release.ts`,
).text();
const classifierRuntime = await file(
  `${import.meta.dir}/../scripts/classify-release-runtime.ts`,
).text();

const importSpecifiers = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/from ['"](?<specifier>[^'"]+)['"]/gu)]
    .map((match) => match.groups?.specifier)
    .filter((specifier): specifier is string => specifier !== undefined);

const readModuleClosure = async (
  module: URL,
  visited: Set<string>,
): Promise<ReadonlyArray<string>> => {
  if (visited.has(module.href)) {
    return [];
  }
  visited.add(module.href);
  const source = await file(module).text();
  const dependencies = importSpecifiers(source)
    .filter((specifier) => specifier.startsWith('.'))
    .map(
      (specifier) =>
        new URL(
          specifier.endsWith('.ts') ? specifier : `${specifier}.ts`,
          module,
        ),
    );
  const descendants = await Promise.all(
    dependencies.map((dependency) => readModuleClosure(dependency, visited)),
  );
  return [source, ...descendants.flat()];
};

it('keeps the eager classifier closure narrow and built-in-only', async () => {
  const classifierClosure = await readModuleClosure(
    new URL('../scripts/classify-release.ts', import.meta.url),
    new Set(),
  );
  const closure = classifierClosure.join('\n');
  const moduleSpecifiers = classifierClosure
    .flatMap(importSpecifiers)
    .filter((specifier) => !specifier.startsWith('.'));
  expect(moduleSpecifiers).toEqual([]);
  expect(classifierRuntime).toContain("['node', 'fs/promises'].join(':')");
  expect(classifierRuntime).toContain("['node', 'process'].join(':')");
  expect(classifier).toContain("from './classify-release-runtime'");
  expect(classifier).toContain("from '../src/release-declaration'");
  expect(closure).not.toContain("from '../src/release-runtime'");
  expect(closure).not.toContain("from 'bun'");
  expect(closure).not.toContain("from 'effect");
});
