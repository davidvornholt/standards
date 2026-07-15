import { describe, expect, it } from 'bun:test';
import { inspectModuleSyntax } from './module-syntax';

describe('module syntax inspection', () => {
  it('discovers runtime and type-only module references', () => {
    expect(
      inspectModuleSyntax(`
        import type { Type } from 'type-package';
        import 'side-effect-package';
        export type { Reexport } from 'reexport-package';
        import Alias = require('alias-package');
        type Imported = import('import-type-package').Imported;
        await import('dynamic-package');
        require('require-package');
        require.resolve('resolved-package');
      `).specifiers.toSorted(),
    ).toEqual([
      'alias-package',
      'dynamic-package',
      'import-type-package',
      'reexport-package',
      'require-package',
      'resolved-package',
      'side-effect-package',
      'type-package',
    ]);
  });

  it('resolves the authorized string-array join syntax', () => {
    expect(
      inspectModuleSyntax("await import(['node', 'process'].join(':'))"),
    ).toEqual({ problems: [], specifiers: ['node:process'] });
  });

  it('fails closed on opaque and alternate loaders', () => {
    const getBuiltinProblem = 'getBuiltinModule uses unsupported loader syntax';
    const requireProblem = 'require uses unsupported loader syntax';
    const cases = [
      ['import(moduleName)', 'import requires a statically known specifier'],
      ['require(moduleName)', 'require requires a statically known specifier'],
      [
        'require.resolve(moduleName)',
        'require.resolve requires a statically known specifier',
      ],
      ["require?.('effect')", requireProblem],
      ["process.getBuiltinModule('module')", getBuiltinProblem],
      ["process['getBuiltinModule']('module')", getBuiltinProblem],
      ["globalThis.process['getBuiltinModule']('module')", getBuiltinProblem],
      ["process.getBuiltinModule.call(process, 'module')", getBuiltinProblem],
      [
        "const get = process.getBuiltinModule; get('module')",
        getBuiltinProblem,
      ],
      [
        "const { getBuiltinModule: get } = process; get('module')",
        getBuiltinProblem,
      ],
      [
        "import { getBuiltinModule as get } from 'node:process'; get('module')",
        getBuiltinProblem,
      ],
      ["const p = process; p.getBuiltinModule('module')", getBuiltinProblem],
      [
        "const { process: p } = globalThis; p.getBuiltinModule('module')",
        getBuiltinProblem,
      ],
      [
        "const p = require('node:process'); p.getBuiltinModule('module')",
        getBuiltinProblem,
      ],
      [
        "const { getBuiltinModule: get } = require('node:process'); get('module')",
        getBuiltinProblem,
      ],
      [
        "const p = await import('node:process'); p.getBuiltinModule('module')",
        getBuiltinProblem,
      ],
      [
        "const { getBuiltinModule: get } = await import('node:process'); get('module')",
        getBuiltinProblem,
      ],
      [
        "import p = require('node:process'); p.getBuiltinModule('module')",
        getBuiltinProblem,
      ],
      ["const load = require; load('effect')", requireProblem],
      ["require.call(null, 'effect')", requireProblem],
      ["const resolve = require.resolve; resolve('effect')", requireProblem],
      ["const load = globalThis.require; load('effect')", requireProblem],
      ["const load = module['require']; load('effect')", requireProblem],
      ["const { require: load } = globalThis; load('effect')", requireProblem],
    ] as const;
    for (const [source, problem] of cases) {
      expect(inspectModuleSyntax(source).problems).toEqual([problem]);
    }
  });

  it('keeps scanning nested loader arguments', () => {
    expect(
      inspectModuleSyntax(
        "require.resolve('node:fs', require('effect')); import('node:fs', { with: require('effect') });",
      ).specifiers,
    ).toEqual(['node:fs', 'effect']);
  });

  it('ignores module-like syntax in inert and unrelated constructs', () => {
    expect(
      inspectModuleSyntax(`
        const example = "import('./ghost')";
        const regex = /require('effect')|import('effect')/;
        const object = { require: 'value', getBuiltinModule: 'value' };
        object.require('not-a-module');
        object.getBuiltinModule();
        const requireMethod = object.require;
        const builtinMethod = object.getBuiltinModule;
        // require('effect');
        /* process.getBuiltinModule('module'); */
      `),
    ).toEqual({ problems: [], specifiers: [] });
  });
});
