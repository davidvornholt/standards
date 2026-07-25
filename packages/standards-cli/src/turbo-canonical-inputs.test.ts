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

// `packages/a11y-testing/src/**` and `packages/typescript-config/*.json` both
// declare coverage of a manifest directory; reduce either to the directory it
// is rooted in so one comparison handles literals and globs alike.
const inputRoot = (input: string): string => {
  const segments = input.slice(ROOT_TOKEN.length).split('/');
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
    .map(inputRoot);
};

const covers = (root: string, path: string): boolean =>
  root === path || root.startsWith(`${path}/`) || path.startsWith(`${root}/`);

describe('canonical payload as a test input', () => {
  it('declares every managed path in the standards test task inputs', () => {
    const inputs = rootedInputs();
    const uncovered = manifestPaths().filter(
      (path) => !inputs.some((root) => covers(root, path)),
    );

    expect(uncovered).toEqual([]);
  });
});
