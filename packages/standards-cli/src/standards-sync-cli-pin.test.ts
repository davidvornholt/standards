import { afterEach, expect, it } from 'bun:test';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { cleanupTmpDirs, mkTmp, write } from './cli-test-support';
import { parsedWorkflow } from './standards-sync-broker-workflow-contract';
import { runSyncStep } from './standards-sync-workflow-test-support';

const MODE = 0o755;
const RAISE_STEP = 'Raise standards CLI pin';
const DIST_TAGS_URL =
  'https://registry.npmjs.org/-/package/@davidvornholt%2Fstandards/dist-tags';

afterEach(cleanupTmpDirs);

// The fake registry records the URL it was asked for and answers with the
// fixture's dist-tags, or fails like `curl --fail` on an HTTP error.
const FAKE_CURL = `#!/usr/bin/env bash
for argument in "$@"; do last=$argument; done
echo "$last" >> "$CURL_CALLS"
if [ "$FAIL_REGISTRY" = true ]; then exit 22; fi
cat "$REGISTRY_RESPONSE"
`;

const manifest = (pin: string | undefined): string =>
  `${JSON.stringify(
    {
      name: 'consumer',
      private: true,
      workspaces: ['apps/*', 'packages/*'],
      scripts: { check: 'standards check' },
      devDependencies: {
        '@biomejs/biome': '2.5.15',
        ...(pin === undefined ? {} : { '@davidvornholt/standards': pin }),
        turbo: '^2.11.7',
      },
    },
    null,
    2,
  )}\n`;

type Fixture = {
  readonly pin?: string;
  readonly latest?: string;
  readonly failRegistry?: boolean;
};

const raise = (fixture: Fixture) => {
  const root = mkTmp('sync-cli-pin-');
  const cwd = join(root, 'consumer');
  const before = manifest(fixture.pin);
  write(cwd, 'package.json', before);
  write(root, 'bin/curl', FAKE_CURL);
  chmodSync(join(root, 'bin/curl'), MODE);
  write(
    root,
    'dist-tags.json',
    JSON.stringify({ latest: fixture.latest ?? '0.38.0', next: '0.39.0-rc.1' }),
  );
  const result = runSyncStep(cwd, RAISE_STEP, {
    ...process.env,
    ...Object.fromEntries([
      ['PATH', `${join(root, 'bin')}:${process.env.PATH ?? ''}`],
      ['CURL_CALLS', join(root, 'curl-calls')],
      ['REGISTRY_RESPONSE', join(root, 'dist-tags.json')],
      ['FAIL_REGISTRY', String(fixture.failRegistry === true)],
      ['RUNNER_TEMP', root],
      ['GITHUB_OUTPUT', join(root, 'github-output')],
    ]),
  });
  const read = (path: string): string =>
    existsSync(path) ? readFileSync(path, 'utf8') : '';
  return {
    result,
    before,
    after: read(join(cwd, 'package.json')),
    output: read(join(root, 'github-output')),
    curlCalls: read(join(root, 'curl-calls')),
  };
};

it.each([
  ['an older release', '0.31.0', '0.38.0'],
  // Text order would put 0.10.0 before 0.9.0.
  ['a lower minor that sorts after the release as text', '0.9.0', '0.10.0'],
])('raises %s to the newest release', (_label, pin, latest) => {
  const outcome = raise({ pin, latest });

  expect(outcome.result.status).toBe(0);
  expect(outcome.after).toBe(manifest(latest));
  expect(outcome.output).toBe(`from=${pin}\nto=${latest}\n`);
  expect(outcome.curlCalls).toBe(`${DIST_TAGS_URL}\n`);
});

it.each([
  ['the newest release', '0.38.0'],
  ['a later version than the newest release', '0.39.0'],
])('keeps a pin at %s', (_label, pin) => {
  const outcome = raise({ pin, latest: '0.38.0' });

  expect(outcome.result.status).toBe(0);
  expect(outcome.after).toBe(outcome.before);
  expect(outcome.output).toBe('');
});

it.each<[string, Fixture, string]>([
  ['the registry fails', { pin: '0.31.0', failRegistry: true }, '::warning::'],
  [
    'the newest release is a prerelease',
    { pin: '0.31.0', latest: '0.39.0-beta.1' },
    '::warning::',
  ],
  ['the pin is a range', { pin: '^0.31.0' }, '::notice::'],
  ['the pin is missing', {}, '::notice::'],
])('leaves package.json as it is when %s', (_label, fixture, annotation) => {
  const outcome = raise(fixture);

  expect(outcome.result.status).toBe(0);
  expect(outcome.result.stdout).toContain(annotation);
  expect(outcome.after).toBe(outcome.before);
  expect(outcome.output).toBe('');
});

it('raises the pin only for an unpinned Bun consumer, after sync and before the lockfile refresh', () => {
  const names = parsedWorkflow.jobs.sync.steps.map((step) => step.name);
  const raiseIndex = names.indexOf(RAISE_STEP);
  const raiseStep = parsedWorkflow.jobs.sync.steps[raiseIndex];

  expect(raiseIndex).toBe(
    names.indexOf('Sync canonical files from upstream') + 1,
  );
  expect(names[raiseIndex + 1]).toBe('Refresh consumer lockfile');
  expect(raiseStep?.if).toBe(
    "needs.policy.outputs.payload == 'bun' && needs.policy.outputs.ref == ''",
  );
  // The step reads only the public registry and never runs the branch's code.
  expect(raiseStep?.env).toBeUndefined();
  expect(raiseStep?.run).not.toContain('bun ');
});
