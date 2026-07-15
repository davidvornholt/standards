import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { inspectModuleSyntax } from '@davidvornholt/module-syntax-inspection';

const LEADING_CURRENT_DIRECTORY = /^\.\//u;

const packageRoot = join(import.meta.dir, '..');
const manifest = JSON.parse(
  readFileSync(join(packageRoot, 'package.json'), 'utf8'),
) as {
  readonly bin?: Readonly<Record<string, string>> | string;
  readonly exports?: unknown;
  readonly files: ReadonlyArray<string>;
};
const productionFiles = manifest.files.filter(
  (path) => path.startsWith('src/') && path.endsWith('.ts'),
);

const stringLeaves = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringLeaves);
  }
  return typeof value === 'object' && value !== null
    ? Object.values(value).flatMap(stringLeaves)
    : [];
};

const productionEntrypoints = [
  ...stringLeaves(manifest.bin),
  ...stringLeaves(manifest.exports),
]
  .map((path) => path.replace(LEADING_CURRENT_DIRECTORY, ''))
  .filter((path) => path.startsWith('src/') && path.endsWith('.ts'))
  .filter((path, index, paths) => paths.indexOf(path) === index);

type ImportGraph = {
  readonly forbidden: ReadonlyArray<string>;
  readonly graph: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly unreachable: ReadonlyArray<string>;
  readonly unusedAllowedBuiltins: ReadonlyArray<string>;
  readonly unsupported: ReadonlyArray<string>;
  readonly unresolved: ReadonlyArray<string>;
};

const ALLOWED_PRODUCTION_BUILTINS: ReadonlySet<string> = new Set([
  'bun',
  'bun:ffi',
  'node:child_process',
  'node:crypto',
  'node:fs',
  'node:fs/promises',
  'node:os',
  'node:path',
  'node:process',
]);

export const productionImportGraph = (
  overrides: ReadonlyMap<string, string> = new Map(),
  additionalFiles: ReadonlyMap<string, string> = new Map(),
): ImportGraph => {
  const files = [...productionFiles, ...additionalFiles.keys()];
  const productionFileSet = new Set(files);
  const forbidden: Array<string> = [];
  const graph = new Map<string, ReadonlyArray<string>>();
  const usedBuiltins = new Set<string>();
  const unsupported: Array<string> = [];
  const unresolved = productionEntrypoints
    .filter((path) => !productionFileSet.has(path))
    .map((path) => `entrypoint -> ${path}`);
  for (const path of files) {
    const source =
      overrides.get(path) ??
      additionalFiles.get(path) ??
      readFileSync(join(packageRoot, path), 'utf8');
    const syntax = inspectModuleSyntax(source);
    unsupported.push(
      ...syntax.problems.map((problem) => `${path} -> ${problem}`),
    );
    const dependencies = syntax.specifiers.flatMap((specifier) => {
      if (!specifier.startsWith('.')) {
        if (ALLOWED_PRODUCTION_BUILTINS.has(specifier)) {
          usedBuiltins.add(specifier);
        } else {
          forbidden.push(`${path} -> ${specifier}`);
        }
        return [];
      }
      const candidate = normalize(
        join(
          dirname(path),
          specifier.endsWith('.ts') ? specifier : `${specifier}.ts`,
        ),
      );
      if (!productionFileSet.has(candidate)) {
        unresolved.push(`${path} -> ${candidate}`);
        return [];
      }
      return [candidate];
    });
    graph.set(path, [...new Set(dependencies)]);
  }
  const reachable = new Set<string>();
  const visit = (path: string): void => {
    if (reachable.has(path)) {
      return;
    }
    reachable.add(path);
    for (const dependency of graph.get(path) ?? []) {
      visit(dependency);
    }
  };
  for (const entrypoint of productionEntrypoints) {
    if (graph.has(entrypoint)) {
      visit(entrypoint);
    }
  }
  const unreachable = files.filter((path) => !reachable.has(path));
  const unusedAllowedBuiltins = [...ALLOWED_PRODUCTION_BUILTINS].filter(
    (specifier) => !usedBuiltins.has(specifier),
  );
  return {
    forbidden,
    graph,
    unreachable,
    unusedAllowedBuiltins,
    unsupported,
    unresolved,
  };
};

export const mutatedProductionGraph = (addition: string): ImportGraph => {
  const path = 'src/cli.ts';
  const source = readFileSync(join(packageRoot, path), 'utf8');
  return productionImportGraph(new Map([[path, `${source}\n${addition}\n`]]));
};

export const importCycle = (
  graph: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<string> | null => {
  const visited = new Set<string>();
  const visit = (
    path: string,
    ancestors: ReadonlyArray<string>,
  ): ReadonlyArray<string> | null => {
    const cycleStart = ancestors.indexOf(path);
    if (cycleStart >= 0) {
      return [...ancestors.slice(cycleStart), path];
    }
    if (visited.has(path)) {
      return null;
    }
    for (const dependency of graph.get(path) ?? []) {
      const cycle = visit(dependency, [...ancestors, path]);
      if (cycle !== null) {
        return cycle;
      }
    }
    visited.add(path);
    return null;
  };

  return [...graph.keys()].reduce<ReadonlyArray<string> | null>(
    (cycle, path) => cycle ?? visit(path, []),
    null,
  );
};
