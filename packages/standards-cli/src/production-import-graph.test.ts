import { describe, expect, it } from 'bun:test';
import { inspectModuleSyntax } from '@davidvornholt/module-syntax-inspection';
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
    expect(inspectModuleSyntax(source)).toEqual({
      problems: [],
      specifiers: ['./valid'],
    });
  });

  it('keeps the packed production closure complete and built-in only', () => {
    const result = productionImportGraph();
    expect({
      cycle: importCycle(result.graph),
      forbidden: result.forbidden,
      unreachable: result.unreachable,
      unusedAllowedBuiltins: result.unusedAllowedBuiltins,
      unsupported: result.unsupported,
      unresolved: result.unresolved,
    }).toEqual({
      cycle: null,
      forbidden: [],
      unreachable: [],
      unusedAllowedBuiltins: [],
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
      'import requires a statically known specifier',
    ],
    [
      'computed require',
      'const moduleName = "node:fs"; require(moduleName);',
      'require requires a statically known specifier',
    ],
    [
      'computed require.resolve',
      'const moduleName = "node:fs"; require.resolve(moduleName);',
      'require.resolve requires a statically known specifier',
    ],
    [
      'optional require',
      "require?.('third-party');",
      'require uses unsupported loader syntax',
    ],
    [
      'template import',
      computedTemplateImport,
      'import requires a statically known specifier',
    ],
  ])('rejects the %s mutation', (_label, addition, problem) => {
    expect(mutatedProductionGraph(addition).unsupported).toEqual([
      `src/cli.ts -> ${problem}`,
    ]);
  });
});

describe('published production closure policy', () => {
  it('rejects a parenthesized third-party require mutation', () => {
    expect(
      mutatedProductionGraph("(require)('third-party');").forbidden,
    ).toEqual(['src/cli.ts -> third-party']);
  });

  it('rejects an external TypeScript import-type mutation', () => {
    expect(
      mutatedProductionGraph("type External = import('third-party').Type;")
        .forbidden,
    ).toEqual(['src/cli.ts -> third-party']);
  });

  it('rejects createRequire as an alternate loader for Effect', () => {
    const mutation = `
      import { createRequire } from 'node:module';
      const load = createRequire(import.meta.url);
      load('effect');
    `;
    expect(mutatedProductionGraph(mutation).forbidden).toEqual([
      'src/cli.ts -> node:module',
    ]);
  });

  it('rejects process.getBuiltinModule as an alternate loader', () => {
    const mutation = `
      const module = process.getBuiltinModule('module');
      module.createRequire(import.meta.url)('effect');
    `;
    expect(mutatedProductionGraph(mutation).unsupported).toEqual([
      'src/cli.ts -> getBuiltinModule uses unsupported loader syntax',
    ]);
  });

  it('rejects aliased process bindings as alternate loaders', () => {
    const mutations = [
      "const processAlias = process; processAlias.getBuiltinModule('module');",
      "const processAlias = require('node:process'); processAlias.getBuiltinModule('module');",
      "const processAlias = await import('node:process'); processAlias.getBuiltinModule('module');",
      "import processAlias = require('node:process'); processAlias.getBuiltinModule('module');",
    ];
    for (const mutation of mutations) {
      expect(mutatedProductionGraph(mutation).unsupported).toEqual([
        'src/cli.ts -> getBuiltinModule uses unsupported loader syntax',
      ]);
    }
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
