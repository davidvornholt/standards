import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const packageRoot = join(import.meta.dir, '..');
const manifest = JSON.parse(
  readFileSync(join(packageRoot, 'package.json'), 'utf8'),
) as { readonly files: ReadonlyArray<string> };
const productionFiles = manifest.files.filter(
  (path) => path.startsWith('src/') && path.endsWith('.ts'),
);
const productionFileSet = new Set(productionFiles);

type ImportGraph = {
  readonly graph: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly unresolved: ReadonlyArray<string>;
};

const RELATIVE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](?<path>\.[^"']+)["']/gu;

const relativeImports = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(RELATIVE_IMPORT)].flatMap((match) =>
    match.groups?.path === undefined ? [] : [match.groups.path],
  );

const productionImportGraph = (): ImportGraph => {
  const graph = new Map<string, ReadonlyArray<string>>();
  const unresolved: Array<string> = [];
  for (const path of productionFiles) {
    const imports = relativeImports(
      readFileSync(join(packageRoot, path), 'utf8'),
    );
    const dependencies = imports.flatMap((fileName) => {
      if (!fileName.startsWith('.')) {
        return [];
      }
      const candidate = normalize(
        join(
          dirname(path),
          fileName.endsWith('.ts') ? fileName : `${fileName}.ts`,
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
  return { graph, unresolved };
};

const importCycle = (
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
    const nextAncestors = [...ancestors, path];
    for (const dependency of graph.get(path) ?? []) {
      const cycle = visit(dependency, nextAncestors);
      if (cycle !== null) {
        return cycle;
      }
    }
    visited.add(path);
    return null;
  };

  for (const path of graph.keys()) {
    const cycle = visit(path, []);
    if (cycle !== null) {
      return cycle;
    }
  }
  return null;
};

describe('published production import graph', () => {
  it('contains every relative production dependency', () => {
    expect(productionImportGraph().unresolved).toEqual([]);
  });

  it('remains acyclic across runtime and type imports', () => {
    expect(importCycle(productionImportGraph().graph)).toBeNull();
  });
});
