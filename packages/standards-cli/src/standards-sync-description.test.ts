import { afterEach, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { cleanupTmpDirs, mkTmp, write } from './cli-test-support';
import {
  DESCRIBE_STEP,
  fakeGitHub,
  PR_BODY_FILE,
  runSyncStep,
} from './standards-sync-workflow-test-support';

afterEach(cleanupTmpDirs);

const UPSTREAM = 'davidvornholt/standards';
const PREVIOUS = '3821c61b0129dd01e48ae97566d1149848b4b446';
const CURRENT = '2daab2939e4ff56cf5df8f9265f2666bc04c2728';
const COMMIT_LIMIT = 30;
const PATH_LIMIT = 50;
const COMPARE = `## Upstream changes\n\n[Compare \`3821c61...2daab29\`](https://github.com/${UPSTREAM}/compare/${PREVIOUS}...${CURRENT})`;
const VERIFICATION =
  '## Verification\n\n### Completed checks\n\n- None in the [`Standards sync` run](https://github.com/owner/repo/actions/runs/42) that generated this description; the required checks on this pull request validate the synced files. Each run that changes the mirror regenerates this description.';
const BEFORE_MERGING =
  '## Before merging\n\n`.github/settings.json` changed. With admin-authenticated `gh`, run `bun standards github --apply` on this branch, then re-run the `check` job; it fails until the declared settings are live.';
const OUT_OF_DATE = `**Before.** This repository mirrors \`${UPSTREAM}\` at \`3821c61\`. Upstream is now at \`2daab29\`, so the mirrored files here are out of date.`;
const MATCHED = `**Now.** The mirrored files match \`${UPSTREAM}\` at \`2daab29\`.`;

const lock = (sha: string): string =>
  `${JSON.stringify({ upstream: `github:${UPSTREAM}`, sha, files: {} })}\n`;
// The GitHub compare response uses snake_case field names.
const comparison = (total: number, messages: ReadonlyArray<string>) =>
  Object.fromEntries([
    ['total_commits', total],
    ['commits', messages.map((message) => ({ commit: { message } }))],
  ]);
const changedFiles = (paths: ReadonlyArray<string>): string =>
  `## Changed files\n\n${paths.map((path) => `- \`${path}\``).join('\n')}`;
const body = (...sections: ReadonlyArray<string>): string =>
  `${sections.join('\n\n')}\n`;
const numbered = (count: number, name: (index: number) => string) =>
  Array.from({ length: count }, (_, index) => name(index));
const docs = numbered(
  PATH_LIMIT + 1,
  (index) => `docs/file-${String(index).padStart(2, '0')}.md`,
);
// Upstream subjects are untrusted, so shell and printf syntax must stay literal.
const subjects = [
  ...numbered(COMMIT_LIMIT - 1, (index) => `chore: step ${index}`),
  'docs: keep $(id), `x` and %s literal',
  'fix: keep other/repo#3 and a#5 (#12)',
];

type Fixture = {
  readonly base: Readonly<Record<string, string>>;
  readonly head: Readonly<Record<string, string>>;
  readonly compare?: unknown;
  readonly failCompare?: boolean;
};
type Scenario = Fixture & {
  readonly name: string;
  readonly expected: string;
  readonly apiCalls: string;
  readonly warns?: boolean;
};

const scenarios: Array<Scenario> = [
  {
    name: 'lock-only sync lists upstream commits without changed files',
    base: { 'canonical.txt': 'one\n', 'sync-standards.lock': lock(PREVIOUS) },
    head: { 'sync-standards.lock': lock(CURRENT) },
    compare: comparison(1, [
      'fix(turbo): rerun the standards tests when the root README or docs change (#447)\n\nBody text.',
    ]),
    expected: body(
      `**Before.** This repository mirrors \`${UPSTREAM}\` at \`3821c61\`. Upstream is now at \`2daab29\`, but none of its changes touch the files mirrored here.`,
      '**Now.** The lock records `2daab29`; no mirrored file changes.',
      COMPARE,
      `- fix(turbo): rerun the standards tests when the root README or docs change (${UPSTREAM}#447)`,
      VERIFICATION,
    ),
    apiCalls: `repos/${UPSTREAM}/compare/${PREVIOUS}...${CURRENT}\n`,
  },
  {
    name: 'settings change keeps the comparison link when commits cannot be listed',
    base: { 'canonical.txt': 'one\n', 'sync-standards.lock': lock(PREVIOUS) },
    head: {
      '.github/settings.json': '{}\n',
      'canonical.txt': 'two\n',
      'sync-standards.lock': lock(CURRENT),
    },
    failCompare: true,
    expected: body(
      OUT_OF_DATE,
      MATCHED,
      COMPARE,
      changedFiles([
        '.github/settings.json',
        'canonical.txt',
        'sync-standards.lock',
      ]),
      BEFORE_MERGING,
      VERIFICATION,
    ),
    apiCalls: `repos/${UPSTREAM}/compare/${PREVIOUS}...${CURRENT}\n`,
    warns: true,
  },
  {
    name: 'long ranges cap commits and paths and qualify only bare issue references',
    base: { 'sync-standards.lock': lock(PREVIOUS) },
    head: {
      ...Object.fromEntries(docs.map((path) => [path, 'doc\n'])),
      'sync-standards.lock': lock(CURRENT),
    },
    compare: comparison(subjects.length + 1, subjects),
    expected: body(
      OUT_OF_DATE,
      MATCHED,
      COMPARE,
      [
        '- Earlier commits not listed here: 2.',
        ...subjects
          .slice(-COMMIT_LIMIT)
          .map(
            (subject) => `- ${subject.replace('(#12)', `(${UPSTREAM}#12)`)}`,
          ),
      ].join('\n'),
      `${changedFiles(docs.slice(0, PATH_LIMIT))}\n- Files not listed here: 2.`,
      VERIFICATION,
    ),
    apiCalls: `repos/${UPSTREAM}/compare/${PREVIOUS}...${CURRENT}\n`,
  },
  {
    name: 'drift from the recorded commit skips the comparison',
    base: { 'canonical.txt': 'one\n', 'sync-standards.lock': lock(CURRENT) },
    head: { 'canonical.txt': 'restored\n' },
    expected: body(
      `**Before.** Mirrored files here differ from \`${UPSTREAM}\` at \`2daab29\`, the commit the lock already records.`,
      MATCHED,
      changedFiles(['canonical.txt']),
      VERIFICATION,
    ),
    apiCalls: '',
  },
  {
    name: 'first sync describes a base branch without a lock',
    base: { 'README.md': 'consumer\n' },
    head: { 'canonical.txt': 'one\n', 'sync-standards.lock': lock(CURRENT) },
    expected: body(
      '**Before.** The base branch records no upstream commit in `sync-standards.lock`.',
      MATCHED,
      changedFiles(['canonical.txt', 'sync-standards.lock']),
      VERIFICATION,
    ),
    apiCalls: '',
  },
];

const git = (cwd: string, ...args: Array<string>): void => {
  execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.invalid',
      ...args,
    ],
    { cwd, stdio: 'ignore' },
  );
};
const commitFiles = (
  cwd: string,
  files: Readonly<Record<string, string>>,
  message: string,
): void => {
  for (const [path, content] of Object.entries(files)) {
    write(cwd, path, content);
  }
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-m', message);
};

// The base commit stands in for the fetched base branch; the head commit is
// the pushed sync branch.
const runDescription = (fixture: Fixture) => {
  const root = mkTmp('sync-description-');
  const cwd = join(root, 'consumer');
  git(root, 'init', '--initial-branch=main', cwd);
  commitFiles(cwd, fixture.base, 'base');
  git(cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(cwd, 'switch', '-c', 'standards-sync/update');
  commitFiles(cwd, fixture.head, 'chore: sync standards from upstream');
  write(
    root,
    'runtime/sync-standards.json',
    JSON.stringify({ upstream: `github:${UPSTREAM}` }),
  );
  write(root, 'compare.json', JSON.stringify(fixture.compare ?? {}));
  const result = runSyncStep(cwd, DESCRIBE_STEP, {
    ...process.env,
    ...fakeGitHub(root, process.env.PATH ?? ''),
    ...Object.fromEntries([
      ['STANDARDS_SYNC_RUNTIME', join(root, 'runtime')],
      ['SYNC_BASE_REF', 'main'],
      ['GITHUB_SERVER_URL', 'https://github.com'],
      ['GITHUB_REPOSITORY', 'owner/repo'],
      ['GITHUB_RUN_ID', '42'],
      ['FAIL_COMPARE', String(fixture.failCompare === true)],
    ]),
  });
  const read = (name: string): string =>
    existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : '';
  return {
    result,
    body: read(PR_BODY_FILE),
    apiCalls: read('api-calls'),
  };
};

it.each(scenarios)('$name', (scenario) => {
  const outcome = runDescription(scenario);

  expect(outcome.result.status).toBe(0);
  expect(outcome.body).toBe(scenario.expected);
  expect(outcome.apiCalls).toBe(scenario.apiCalls);
  expect(outcome.result.stdout.includes('::warning::')).toBe(
    scenario.warns === true,
  );
});

it('fails when the sync branch lock does not record the synced commit', () => {
  const outcome = runDescription({
    base: { 'sync-standards.lock': lock(PREVIOUS) },
    head: { 'sync-standards.lock': '{}\n' },
  });

  expect(outcome.result.status).not.toBe(0);
  expect(outcome.apiCalls).toBe('');
});
