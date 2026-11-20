import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { parse } from 'yaml';
import {
  cleanupTmpDirs,
  mkTmp,
  type RunResult,
  runProcess,
  write,
  yamlRunScript,
} from './cli-test-support';
import { WORKFLOW } from './standards-workflow-test-support';

afterEach(cleanupTmpDirs);

const PAYLOAD_STEP = 'Read the standards payload';
const FETCH_STEP = 'Fetch the standards CLI source';
const INSTALL_STEP = 'Install the standards CLI dependencies';
const CHECK_STEP = 'Check';
const PAYLOAD = 'steps.payload.outputs.payload';
// Every payload runs these steps. They need the checkout, the runner, and Bun,
// and no Bun workspace. Setup Bun caches Bun through the Actions cache, which
// zstd speeds up on CodeBuild.
const SHARED_STEPS: ReadonlyArray<string> = [
  'Checkout',
  'Record the validated tree',
  'Lint workflows',
  PAYLOAD_STEP,
  'Install zstd for the Actions cache',
  'Setup Bun',
  'Verify Bun version',
  CHECK_STEP,
];
const CORE_STEPS: ReadonlyArray<string> = [FETCH_STEP, INSTALL_STEP];
// `&&` binds tighter than `||`, so any alternative would escape the gate.
const BUN_GATE = /^steps\.payload\.outputs\.payload == 'bun'(?: && [^|]+)?$/u;

type Step = { readonly name: string; readonly if?: string };

const qualitySteps = (): ReadonlyArray<Step> =>
  (
    parse(readFileSync(WORKFLOW, 'utf8')) as {
      readonly jobs: { readonly quality: { readonly steps: Array<Step> } };
    }
  ).jobs.quality.steps;

const runStep = (
  cwd: string,
  name: string,
  environment: Readonly<Record<string, string>>,
): RunResult =>
  runProcess(
    'bash',
    cwd,
    ['-euo', 'pipefail', '-c', yamlRunScript(WORKFLOW, name)],
    { ...process.env, ...environment },
  );

const readAssignments = (path: string): Record<string, string> =>
  Object.fromEntries(
    (existsSync(path) ? readFileSync(path, 'utf8') : '')
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [
        line.slice(0, line.indexOf('=')),
        line.slice(line.indexOf('=') + 1),
      ]),
  );

// Which payloads a step condition lets the step run for.
const runsFor = (condition: string | undefined): string => {
  if (condition === undefined || !condition.includes(PAYLOAD)) {
    return 'every payload';
  }
  if (condition === `${PAYLOAD} == 'core'`) {
    return 'core';
  }
  return BUN_GATE.test(condition) ? 'bun' : `unrecognized: ${condition}`;
};

const intendedFor = (name: string): string => {
  if (SHARED_STEPS.includes(name)) {
    return 'every payload';
  }
  return CORE_STEPS.includes(name) ? 'core' : 'bun';
};

describe('standards workflow quality payloads', () => {
  it('gates every step that needs a Bun workspace on the bun payload', () => {
    const steps = qualitySteps();
    expect(steps.map((step) => [step.name, runsFor(step.if)])).toEqual(
      steps.map((step) => [step.name, intendedFor(step.name)]),
    );
  });

  it('reads the payload before any step depends on it', () => {
    const steps = qualitySteps();
    const payloadIndex = steps.findIndex((step) => step.name === PAYLOAD_STEP);
    const firstDependent = steps.findIndex((step) =>
      (step.if ?? '').includes(PAYLOAD),
    );
    expect(payloadIndex).toBeGreaterThan(-1);
    expect(firstDependent).toBeGreaterThan(payloadIndex);
  });

  const readPayload = (
    policy?: string,
  ): { readonly result: RunResult; readonly payload?: string } => {
    const root = mkTmp('standards-workflow-payload-');
    if (policy !== undefined) {
      write(root, 'sync-standards.local.json', policy);
    }
    const output = join(root, 'github-output');
    const result = runStep(
      root,
      PAYLOAD_STEP,
      Object.fromEntries([['GITHUB_OUTPUT', output]]),
    );
    return { result, payload: readAssignments(output).payload };
  };

  it.each([
    ['no sync policy', undefined, 'bun'],
    ['a policy without a payload', '{"autoSync":false}', 'bun'],
    ['the bun payload', '{"payload":"bun"}', 'bun'],
    ['the core payload', '{"payload":"core","ref":"main"}', 'core'],
  ])('reads %s as the %p payload', (_label, policy, expected) => {
    const { result, payload } = readPayload(policy);
    expect(result.status).toBe(0);
    expect(payload).toBe(expected);
  });

  it.each([
    ['an unknown payload', '{"payload":"node"}'],
    ['a null payload', '{"payload":null}'],
    ['a policy that is not an object', '["core"]'],
    ['a policy that is not JSON', 'payload: core'],
  ])('fails for %s', (_label, policy) => {
    const { result, payload } = readPayload(policy);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('::error::');
    expect(payload).toBeUndefined();
  });
});

// The fetch resolves the GitHub URL to a local repository through Git's own
// `insteadOf` rewrite, so the workflow script runs unchanged.
const UPSTREAM = 'github:owner/trusted';
const UPSTREAM_URL = 'https://github.com/owner/trusted.git';
const BUN_VERSION = '1.4.3';
const RUNTIME_DEPENDENCY = '@standards-fixture/runtime-dependency';
const SHA_LENGTH = 40;

// Fixture repositories ignore the machine's Git configuration, so commits work
// the same on a CI runner without a Git identity and on a workstation that
// signs commits.
const GIT_ENVIRONMENT = {
  ...process.env,
  ...Object.fromEntries([
    ['GIT_AUTHOR_EMAIL', 'fixture@example.invalid'],
    ['GIT_AUTHOR_NAME', 'fixture'],
    ['GIT_COMMITTER_EMAIL', 'fixture@example.invalid'],
    ['GIT_COMMITTER_NAME', 'fixture'],
    ['GIT_CONFIG_GLOBAL', '/dev/null'],
    ['GIT_CONFIG_NOSYSTEM', '1'],
  ]),
};

const git = (cwd: string, ...args: Array<string>): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: GIT_ENVIRONMENT,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

// The fixture CLI records its working directory and arguments. It imports a
// workspace package, so it runs only after the workflow installs the CLI's
// dependencies into the fetched source.
const CLI_SOURCE = `import { writeFileSync } from 'node:fs';
import '${RUNTIME_DEPENDENCY}';
const args = process.argv.slice(2);
writeFileSync(args[args.indexOf('--dir') + 1] + '/check-run.json', JSON.stringify({ cwd: process.cwd(), args }));
`;

const seedUpstream = (root: string, packageManager: string): string => {
  const upstream = join(root, 'upstream');
  git(root, 'init', '--initial-branch=main', upstream);
  // GitHub serves any reachable commit by its SHA.
  git(upstream, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
  write(
    upstream,
    'package.json',
    JSON.stringify({
      name: 'fixture-standards',
      private: true,
      packageManager,
      workspaces: ['packages/*'],
    }),
  );
  write(
    upstream,
    'packages/standards-cli/package.json',
    JSON.stringify({
      name: '@davidvornholt/standards',
      version: '0.0.0',
      type: 'module',
      dependencies: Object.fromEntries([[RUNTIME_DEPENDENCY, 'workspace:*']]),
    }),
  );
  write(
    upstream,
    'packages/runtime-dependency/package.json',
    JSON.stringify({
      name: RUNTIME_DEPENDENCY,
      version: '0.0.0',
      type: 'module',
      exports: './index.js',
    }),
  );
  write(upstream, 'packages/runtime-dependency/index.js', 'export {};\n');
  write(upstream, 'packages/standards-cli/src/cli.ts', CLI_SOURCE);
  execFileSync('bun', ['install'], { cwd: upstream, stdio: 'ignore' });
  write(upstream, '.gitignore', 'node_modules/\n');
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-m', 'standards');
  return upstream;
};

const coreFixture = (
  lock: (sha: string) => Record<string, unknown>,
  packageManager = `bun@${BUN_VERSION}`,
): {
  readonly root: string;
  readonly consumer: string;
  readonly environment: Readonly<Record<string, string>>;
} => {
  const root = mkTmp('standards-workflow-core-');
  write(root, 'runner/.keep', '');
  const upstream = seedUpstream(root, packageManager);
  const consumer = join(root, 'consumer');
  write(
    consumer,
    'sync-standards.lock',
    JSON.stringify(lock(git(upstream, 'rev-parse', 'HEAD'))),
  );
  const environment = Object.fromEntries([
    ['GIT_CONFIG_COUNT', '1'],
    ['GIT_CONFIG_KEY_0', `url.file://${upstream}.insteadOf`],
    ['GIT_CONFIG_VALUE_0', UPSTREAM_URL],
    ['GITHUB_ENV', join(root, 'github-env')],
    ['GITHUB_OUTPUT', join(root, 'github-output')],
    ['GITHUB_WORKSPACE', consumer],
    ['RUNNER_TEMP', join(root, 'runner')],
  ]);
  return { root, consumer, environment };
};

describe('standards workflow core check', () => {
  it('runs the check with the CLI from the commit that the lock records', () => {
    const { root, consumer, environment } = coreFixture((sha) => ({
      upstream: UPSTREAM,
      sha,
      files: {},
    }));
    // The consumer's Bun configuration and env file never reach the CLI.
    write(consumer, 'bunfig.toml', 'preload = ["./evil.ts"]\n');
    write(
      consumer,
      'evil.ts',
      "import { writeFileSync } from 'node:fs'; writeFileSync('preload-ran', 'unsafe');\n",
    );

    expect(runStep(consumer, FETCH_STEP, environment).status).toBe(0);
    expect(readAssignments(join(root, 'github-output'))).toEqual(
      Object.fromEntries([['bun-version', BUN_VERSION]]),
    );
    const fetched = readAssignments(join(root, 'github-env'));
    const source = fetched.STANDARDS_SOURCE ?? '';
    expect(source.startsWith(join(root, 'runner/'))).toBe(true);

    const fetchedEnvironment = { ...environment, ...fetched };
    expect(runStep(consumer, INSTALL_STEP, fetchedEnvironment).status).toBe(0);
    const check = runStep(consumer, CHECK_STEP, {
      ...fetchedEnvironment,
      ...Object.fromEntries([['PAYLOAD', 'core']]),
    });
    expect(check.status).toBe(0);
    expect(
      JSON.parse(readFileSync(join(consumer, 'check-run.json'), 'utf8')),
    ).toEqual({ cwd: source, args: ['check', '--dir', consumer] });
    expect(existsSync(join(consumer, 'preload-ran'))).toBe(false);
  });

  it.each([
    ['a non-GitHub upstream', 'file:///srv/standards', (sha: string) => sha],
    ['an upstream with a ref', 'github:owner/trusted/v1', (sha: string) => sha],
    [
      'an upstream that leaves the owner',
      'github:owner/..',
      (sha: string) => sha,
    ],
    ['a short commit', UPSTREAM, (sha: string) => sha.slice(0, 12)],
    [
      'a commit that reads as an option',
      UPSTREAM,
      () => `--${'a'.repeat(SHA_LENGTH - 2)}`,
    ],
    ['no commit', UPSTREAM, () => null],
  ])('fails before fetching for a lock with %s', (_label, upstream, sha) => {
    const { root, consumer, environment } = coreFixture((head) => ({
      upstream,
      sha: sha(head),
      files: {},
    }));
    const result = runStep(consumer, FETCH_STEP, environment);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('::error::');
    expect(readAssignments(join(root, 'github-env'))).toEqual({});
    expect(readdirSync(join(root, 'runner'))).toEqual(['.keep']);
  });

  it.each(['bun@1.4', 'bun@^1.4.3', 'npm@11.0.0'])(
    'rejects a standards packageManager of %p',
    (packageManager) => {
      const { root, consumer, environment } = coreFixture(
        (sha) => ({ upstream: UPSTREAM, sha, files: {} }),
        packageManager,
      );
      const result = runStep(consumer, FETCH_STEP, environment);

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        'must pin an exact bun@x.y.z packageManager',
      );
      expect(readAssignments(join(root, 'github-env'))).toEqual({});
    },
  );
});
