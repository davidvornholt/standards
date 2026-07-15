import { expect, it } from 'bun:test';
import {
  forbiddenClassifierSpecifiers,
  readClassifierModuleClosure,
} from './release-classifier-closure-test-fixture';
import { inspectClassifierSource } from './release-classifier-closure-test-parser';
import { file } from './release-runtime';

const classifier = await file(
  `${import.meta.dir}/../scripts/classify-release.ts`,
).text();
const classifierRuntime = await file(
  `${import.meta.dir}/../scripts/classify-release-runtime.ts`,
).text();
const readModule = (module: URL): Promise<string> => file(module).text();

it('discovers every supported runtime and type-only module form', () => {
  expect(
    inspectClassifierSource(`
      import type { Type } from 'type-package';
      import 'side-effect-package';
      export type { Reexport } from 'reexport-package';
      type Imported = import('import-type-package').Imported;
      await import('dynamic-package');
      require('require-package');
      require.resolve('resolved-package');
    `).specifiers.toSorted(),
  ).toEqual([
    'dynamic-package',
    'import-type-package',
    'reexport-package',
    'require-package',
    'resolved-package',
    'side-effect-package',
    'type-package',
  ]);
});

it('allows explicit built-ins and rejects third-party mutation forms', () => {
  expect(
    forbiddenClassifierSpecifiers([
      "import 'node:fs/promises'; require('node:process');",
    ]),
  ).toEqual([]);
  for (const [mutation, expected] of [
    ["await import('bun');", 'bun'],
    ["require('bun:ffi');", 'bun:ffi'],
    ["import 'effect';", 'effect'],
    ["await import('effect');", 'effect'],
    ["require('effect');", 'effect'],
    ["import type { Effect } from 'effect';", 'effect'],
    ["type Effect = import('effect').Effect;", 'effect'],
    ["await import(['eff', 'ect'].join(''));", 'effect'],
  ] as const) {
    expect(forbiddenClassifierSpecifiers([mutation])).toEqual([expected]);
  }
});

it('rejects opaque loaders without matching comments or strings', () => {
  expect(
    [
      'await import(packageName);',
      'require(packageName);',
      'require.resolve(packageName);',
      "require?.('effect');",
    ].flatMap((source) => inspectClassifierSource(source).problems),
  ).toEqual([
    'import requires a statically known specifier',
    'require requires a statically known specifier',
    'require.resolve requires a statically known specifier',
    'require uses unsupported syntax',
  ]);
  expect(
    inspectClassifierSource(`
      const example = "import('./ghost')";
      // require('effect');
    `),
  ).toEqual({ problems: [], specifiers: [] });
});

it('traverses dynamic and relative type-only helpers', async () => {
  const entry = new URL('file:///classifier.ts');
  const sources = new Map([
    [entry.href, "await import('./helper'); type T = import('./types').T;"],
    ['file:///helper.ts', "import 'effect';"],
    ['file:///types.ts', "import type { Effect } from 'effect';"],
  ]);
  const closure = await readClassifierModuleClosure(
    entry,
    new Set(),
    (module) => Promise.resolve(sources.get(module.href) ?? ''),
  );
  expect(forbiddenClassifierSpecifiers(closure)).toEqual(['effect', 'effect']);
});

it('keeps the eager classifier closure narrow and built-in-only', async () => {
  const closure = await readClassifierModuleClosure(
    new URL('../scripts/classify-release.ts', import.meta.url),
    new Set(),
    readModule,
  );
  expect(forbiddenClassifierSpecifiers(closure)).toEqual([]);
  expect(inspectClassifierSource(classifierRuntime)).toMatchObject({
    problems: [],
    specifiers: expect.arrayContaining(['node:fs/promises', 'node:process']),
  });
  expect(classifier).toContain("from './classify-release-runtime'");
  expect(classifier).toContain("from '../src/release-declaration'");
  expect(closure.join('\n')).not.toContain("from '../src/release-runtime'");
});
