// The canonical payload is an input to this package's own test task: suites
// here read `sync-standards.json` and walk the real files it names. A path
// added to the manifest but not to the Turbo inputs leaves those suites able to
// replay a cached result across a change to the very payload they assert on.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTUAL_UPSTREAM } from './cli-test-support';

const TEST_TASK = '@davidvornholt/standards#test';
const ROOT_TOKEN = '$TURBO_ROOT$/';

const readJson = (relativePath: string): unknown =>
  JSON.parse(readFileSync(join(ACTUAL_UPSTREAM, relativePath), 'utf8'));

const manifestPaths = (): ReadonlyArray<string> => {
  const manifest = readJson('sync-standards.json') as {
    paths: ReadonlyArray<string>;
  };
  return manifest.paths;
};

// Manifest directories are deliberately declared as a set of narrower
// inputs, so installed dependencies and build output under them stay out of the
// cache key. Each set is pinned exactly: an input root deeper than the manifest
// path covers only part of it, so accepting one on its own would let any of
// these be narrowed further — or an unrelated directory be reduced to a single
// subdirectory — without failing anything.
const NARROWED: Readonly<Record<string, ReadonlyArray<string>>> = {
  '.github/actions/read-standards-policy': [
    '.github/actions/read-standards-policy/action.yml',
  ],
  '.github/actions/sops-secret': ['.github/actions/sops-secret/action.yml'],
  'packages/typescript-config': [
    'packages/typescript-config/README.md',
    'packages/typescript-config/*.json',
    'packages/typescript-config/*.ts',
  ],
  'packages/a11y-testing': [
    'packages/a11y-testing/README.md',
    'packages/a11y-testing/package.json',
    'packages/a11y-testing/tsconfig.json',
    'packages/a11y-testing/src/**',
  ],
};

// Reduce a glob to the directory it is rooted in, so one comparison handles
// literals and globs alike.
const inputRoot = (input: string): string => {
  const segments = input.split('/');
  const globIndex = segments.findIndex((segment) => segment.includes('*'));
  return (globIndex === -1 ? segments : segments.slice(0, globIndex)).join('/');
};

const rootedInputs = (): ReadonlyArray<string> => {
  const turbo = readJson('turbo.json') as {
    tasks: Record<string, { inputs: ReadonlyArray<string> }>;
  };
  const task = turbo.tasks[TEST_TASK];
  if (task === undefined) {
    throw new Error(`turbo.json must define the ${TEST_TASK} task`);
  }
  return task.inputs
    .filter((input) => input.startsWith(ROOT_TOKEN))
    .map((input) => input.slice(ROOT_TOKEN.length));
};

const covers = (root: string, path: string): boolean =>
  root === path || path.startsWith(`${root}/`);

describe('canonical payload as a test input', () => {
  it('declares every managed path in the standards test task inputs', () => {
    const roots = rootedInputs().map(inputRoot);
    const uncovered = manifestPaths().filter(
      (path) => !(path in NARROWED || roots.some((root) => covers(root, path))),
    );

    expect(uncovered).toEqual([]);
  });

  it('pins the exact narrower inputs that stand in for a manifest directory', () => {
    const inputs = rootedInputs();

    for (const [path, expected] of Object.entries(NARROWED)) {
      expect(inputs.filter((input) => covers(path, input))).toEqual([
        ...expected,
      ]);
    }
  });
});
