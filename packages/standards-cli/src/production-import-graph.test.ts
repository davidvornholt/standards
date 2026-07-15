import { describe, expect, it } from 'bun:test';
import { moduleSyntax } from './production-import-graph-test-scanner';
import {
  importCycle,
  mutatedProductionGraph,
  productionImportGraph,
} from './production-import-graph-test-support';

describe('published production import graph', () => {
  const computedTemplateImport = `const name = "fs"; void import(\`node:\${name}\`);`;

  it('ignores module syntax inside strings and comments', () => {
    const source = `
      import { type as foo } from './valid';
      const value = "import('./not-packed')";
      /* require(moduleName); */
      // type T = import('third-party').T
    `;
    expect(moduleSyntax(source)).toEqual({
      specifiers: ['./valid'],
      unsupported: [],
    });
  });

  it('keeps the packed production closure complete and built-in only', () => {
    const result = productionImportGraph();
    expect({
      cycle: importCycle(result.graph),
      forbidden: result.forbidden,
      unreachable: result.unreachable,
      unsupported: result.unsupported,
      unresolved: result.unresolved,
    }).toEqual({
      cycle: null,
      forbidden: [],
      unreachable: [],
      unsupported: [],
      unresolved: [],
    });
  });

  it.each([
    ['side-effect static', "import 'third-party';"],
    ['literal dynamic', "void import('third-party');"],
    ['literal require', "require('third-party');"],
    ['literal require.resolve', "require.resolve('third-party');"],
  ])('rejects a %s third-party import mutation', (_label, addition) => {
    expect(mutatedProductionGraph(addition).forbidden).toEqual([
      'src/cli.ts -> third-party',
    ]);
  });

  it.each([
    ['dynamic import', "void import('./not-packed');"],
    ['literal require', "require('./not-packed');"],
  ])('keeps a %s in the packed reachability graph', (_label, addition) => {
    expect(mutatedProductionGraph(addition).unresolved).toEqual([
      'src/cli.ts -> src/not-packed.ts',
    ]);
  });

  it.each([
    [
      'computed import',
      'const moduleName = "node:fs"; void import(moduleName);',
      'import',
    ],
    [
      'computed require',
      'const moduleName = "node:fs"; require(moduleName);',
      'require',
    ],
    [
      'computed require.resolve',
      'const moduleName = "node:fs"; require.resolve(moduleName);',
      'require.resolve',
    ],
    ['optional require', "require?.('third-party');", 'require'],
    ['parenthesized require', "(require)('third-party');", 'require'],
    ['template import', computedTemplateImport, 'import'],
  ])('rejects the %s mutation', (_label, addition, call) => {
    expect(mutatedProductionGraph(addition).unsupported).toEqual([
      `src/cli.ts -> ${call}`,
    ]);
  });

  it('rejects an external TypeScript import-type mutation', () => {
    expect(
      mutatedProductionGraph("type External = import('third-party').Type;")
        .forbidden,
    ).toEqual(['src/cli.ts -> third-party']);
  });

  it('rejects an allowlisted production module outside public entrypoints', () => {
    expect(
      productionImportGraph(
        new Map(),
        new Map([['src/unreachable.ts', 'export const unreachable = true;']]),
      ).unreachable,
    ).toEqual(['src/unreachable.ts']);
  });
});
