import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { cleanupTmpDirs, mkTmp, write } from './cli-test-support';
import { runSyncStep } from './standards-sync-workflow-test-support';

// These tests point the GitHub URL at a local repository through Git's own
// `insteadOf` rewrite, so the workflow script runs unchanged.
const UPSTREAM = 'github:owner/trusted';
const UPSTREAM_URL = 'https://github.com/owner/trusted.git';
const FETCH_STEP = 'Fetch trusted standards CLI source';
const PRESERVE_STEP = 'Preserve trusted sync runtime';
const SYNC_STEP = 'Sync canonical files from upstream';
const BUN_VERSION = '1.4.3';

afterEach(cleanupTmpDirs);

// Fixture repositories ignore the machine's Git configuration, so commits and
// annotated tags work the same on a CI runner without a Git identity and on a
// workstation that signs commits.
const FIXTURE_GIT_ENVIRONMENT = {
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
    env: FIXTURE_GIT_ENVIRONMENT,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const commitAll = (cwd: string, message: string): string => {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
};

// The fixture CLI records where it ran from and the arguments it received. It
// imports a workspace package, so it runs only after the workflow installs the
// CLI's dependencies into the fetched source.
const RUNTIME_DEPENDENCY = '@standards-fixture/runtime-dependency';

const cliSource = (label: string): string =>
  `import { writeFileSync } from 'node:fs';
import '${RUNTIME_DEPENDENCY}';
const args = process.argv.slice(2);
writeFileSync(args[args.indexOf('--dir') + 1] + '/canonical.txt', ${JSON.stringify(label)} + ' ' + args.join(' ') + '\\n');
`;

const cliManifest = (...dependencies: Array<string>): string =>
  JSON.stringify({
    name: '@davidvornholt/standards',
    version: '0.0.0',
    type: 'module',
    dependencies: Object.fromEntries(
      dependencies.map((name) => [name, 'workspace:*']),
    ),
  });

const writeWorkspacePackage = (
  upstream: string,
  directory: string,
  name: string,
): void => {
  write(
    upstream,
    `packages/${directory}/package.json`,
    JSON.stringify({
      name,
      version: '0.0.0',
      type: 'module',
      exports: './index.js',
    }),
  );
  write(upstream, `packages/${directory}/index.js`, 'export {};\n');
};

const seedUpstream = (
  root: string,
  packageManager = `bun@${BUN_VERSION}`,
): string => {
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
    cliManifest(RUNTIME_DEPENDENCY),
  );
  writeWorkspacePackage(upstream, 'runtime-dependency', RUNTIME_DEPENDENCY);
  write(upstream, 'packages/standards-cli/src/cli.ts', cliSource('first'));
  execFileSync('bun', ['install'], { cwd: upstream, stdio: 'ignore' });
  write(upstream, '.gitignore', 'node_modules/\n');
  return upstream;
};

const seedConsumer = (
  root: string,
  upstream: string,
  name = 'consumer',
): string => {
  const consumer = join(root, name);
  git(root, 'init', '--initial-branch=main', consumer);
  write(consumer, 'sync-standards.json', JSON.stringify({ upstream }));
  write(consumer, 'sync-standards.local.json', '{"payload":"core"}\n');
  return consumer;
};

const stepEnvironment = (
  root: string,
  upstreamPath: string,
  policyRef = '',
): Record<string, string | undefined> => ({
  ...process.env,
  ...Object.fromEntries([
    ['GIT_CONFIG_COUNT', '1'],
    ['GIT_CONFIG_KEY_0', `url.file://${upstreamPath}.insteadOf`],
    ['GIT_CONFIG_VALUE_0', UPSTREAM_URL],
    ['GITHUB_ENV', join(root, 'github-env')],
    ['GITHUB_OUTPUT', join(root, 'github-output')],
    ['RUNNER_TEMP', join(root, 'runner')],
    ['SYNC_PAYLOAD', 'core'],
    ['SYNC_POLICY_REF', policyRef],
  ]),
});

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

const fixture = (
  packageManager?: string,
): { root: string; upstream: string; consumer: string; base: string } => {
  const root = mkTmp('sync-core-runtime-');
  write(root, 'runner/.keep', '');
  const upstream = seedUpstream(root, packageManager);
  const base = commitAll(upstream, 'base');
  const consumer = seedConsumer(root, UPSTREAM);
  return { root, upstream, consumer, base };
};

describe('standards sync workflow core runtime', () => {
  it.each(['', 'main', 'v1', 'pinned'])(
    'runs the CLI from the one upstream commit that ref %p names',
    (refKind) => {
      const { root, upstream, consumer, base } = fixture();
      git(upstream, 'tag', '--annotate', 'v1', '--message', 'v1');
      write(upstream, 'packages/standards-cli/src/cli.ts', cliSource('second'));
      const head = commitAll(upstream, 'second');
      const policyRef = refKind === 'pinned' ? base : refKind;
      const expected = refKind === 'v1' || refKind === 'pinned' ? base : head;
      const label = expected === base ? 'first' : 'second';
      const environment = stepEnvironment(root, upstream, policyRef);

      expect(runSyncStep(consumer, FETCH_STEP, environment).status).toBe(0);
      const fetched = readAssignments(join(root, 'github-env'));
      expect(fetched.STANDARDS_SYNC_REV).toBe(expected);
      expect(readAssignments(join(root, 'github-output'))).toEqual(
        Object.fromEntries([['bun-version', BUN_VERSION]]),
      );

      // The ref moves after the fetch. The sync still mirrors the fetched
      // commit with the CLI from that same commit.
      write(upstream, 'packages/standards-cli/src/cli.ts', cliSource('third'));
      commitAll(upstream, 'third');
      git(upstream, 'tag', '--force', '--annotate', 'v1', '--message', 'v1');

      const runtimeEnvironment = { ...environment, ...fetched };
      expect(
        runSyncStep(consumer, PRESERVE_STEP, runtimeEnvironment).status,
      ).toBe(0);
      const preserved = readAssignments(join(root, 'github-env'));

      // The consumer branch can't load its Bun configuration or env file into
      // the CLI.
      write(consumer, 'bunfig.toml', 'preload = ["./evil.ts"]\n');
      write(
        consumer,
        'evil.ts',
        "import { writeFileSync } from 'node:fs'; writeFileSync('preload-ran', 'unsafe');\n",
      );
      const sync = runSyncStep(consumer, SYNC_STEP, {
        ...runtimeEnvironment,
        ...preserved,
        ...Object.fromEntries([['GITHUB_WORKSPACE', consumer]]),
      });
      expect(sync.status).toBe(0);
      expect(readFileSync(join(consumer, 'canonical.txt'), 'utf8')).toBe(
        `${label} sync --from ${UPSTREAM} --dir ${consumer} --ref ${expected}\n`,
      );
      expect(existsSync(join(consumer, 'preload-ran'))).toBe(false);
    },
  );

  it.each([
    ['a non-GitHub upstream', 'file:///srv/standards', ''],
    ['an upstream with a ref', 'github:owner/trusted/v1', ''],
    ['an upstream that leaves the owner', 'github:owner/..', ''],
    ['a ref that reads as an option', UPSTREAM, '--upload-pack=touch'],
    ['a ref a URL query would carry', UPSTREAM, 'v1?dir=x'],
    ['a refspec', UPSTREAM, 'main:refs/heads/other'],
  ])('fails before fetching for %s', (_label, upstreamName, ref) => {
    const { root, upstream } = fixture();
    const consumer = seedConsumer(root, upstreamName, 'other');
    const result = runSyncStep(
      consumer,
      FETCH_STEP,
      stepEnvironment(root, upstream, ref),
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('::error::');
    expect(readdirSync(join(root, 'runner'))).toEqual(['.keep']);
    expect(existsSync(join(root, 'github-env'))).toBe(false);
  });

  it.each(['bun@1.4', 'bun@^1.4.3', 'npm@11.0.0'])(
    'rejects an upstream packageManager of %p',
    (packageManager) => {
      const { root, upstream, consumer } = fixture(packageManager);
      const result = runSyncStep(
        consumer,
        FETCH_STEP,
        stepEnvironment(root, upstream),
      );

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        'must pin an exact bun@x.y.z packageManager',
      );
      expect(existsSync(join(root, 'github-output'))).toBe(false);
    },
  );

  it('refuses to install dependencies that the upstream lockfile lacks', () => {
    const { root, upstream, consumer } = fixture();
    const unlocked = '@standards-fixture/unlocked';
    write(
      upstream,
      'packages/standards-cli/package.json',
      cliManifest(RUNTIME_DEPENDENCY, unlocked),
    );
    writeWorkspacePackage(upstream, 'unlocked', unlocked);
    commitAll(upstream, 'unlocked dependency');
    const environment = stepEnvironment(root, upstream);
    expect(runSyncStep(consumer, FETCH_STEP, environment).status).toBe(0);

    const preserve = runSyncStep(consumer, PRESERVE_STEP, {
      ...environment,
      ...readAssignments(join(root, 'github-env')),
    });
    expect(preserve.status).not.toBe(0);
    expect(`${preserve.stdout}${preserve.stderr}`).toContain(
      'lockfile is frozen',
    );
    expect(
      readAssignments(join(root, 'github-env')).STANDARDS_SYNC_RUNTIME,
    ).toBeUndefined();
  });
});
