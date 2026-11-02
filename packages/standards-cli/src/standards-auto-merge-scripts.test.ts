import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  ACTUAL_UPSTREAM,
  cleanupTmpDirs,
  mkTmp,
  type RunResult,
  runProcess,
  write,
  yamlRunScript,
} from './cli-test-support';

afterEach(cleanupTmpDirs);

const AUTO_MERGE = join(
  ACTUAL_UPSTREAM,
  '.github/workflows/standards-auto-merge.yml',
);
const SYNC = join(ACTUAL_UPSTREAM, '.github/workflows/standards-sync.yml');
const APP = 'standards-broker';
const PR_URL = 'https://github.com/owner/repo/pull/12';
const HEAD = 'a'.repeat(40);
const MODE = 0o755;

// `pr view` applies the caller's `--jq` filter to the fixture pull request,
// `api graphql` prints the fixture pages, and `api --include` answers a
// merge with the fixture status for its base branch. Every call is recorded.
const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'pr view')
    echo "$*" >> "$GH_CALLS"
    while [ "$1" != --jq ]; do shift; done
    jq -r "$2" "$FIXTURE_DIR/pull-request.json"
    ;;
  'pr merge') echo "$*" >> "$GH_CALLS" ;;
  'api graphql')
    echo 'api graphql' >> "$GH_CALLS"
    cat "$FIXTURE_DIR/pages.json"
    ;;
  'api --include')
    echo "$*" >> "$GH_CALLS"
    status=$(jq -r --arg base "\${7#base=}" '.[$base] // 500' "$FIXTURE_DIR/statuses.json")
    printf 'HTTP/2.0 %s Fixture\\n\\n' "$status"
    [ "\${status:0:1}" = 2 ]
    ;;
  *) exit 1 ;;
esac
`;

// Step environments are name and value pairs; a later pair overrides an
// earlier one with the same name.
type Env = ReadonlyArray<readonly [string, string]>;
type Run = RunResult & { readonly calls: string; readonly output: string };
const run = (
  path: string,
  name: string,
  fixtures: Readonly<Record<string, unknown>>,
  values: Env,
): Run => {
  const root = mkTmp('auto-merge-');
  write(root, 'bin/gh', FAKE_GH);
  chmodSync(join(root, 'bin/gh'), MODE);
  for (const [file, content] of Object.entries(fixtures)) {
    write(root, file, JSON.stringify(content));
  }
  const result = runProcess(
    'bash',
    root,
    ['-e', '-c', yamlRunScript(path, name)],
    {
      ...process.env,
      ...Object.fromEntries([
        ['PATH', `${join(root, 'bin')}:${process.env.PATH ?? ''}`],
        ['FIXTURE_DIR', root],
        ['GH_CALLS', join(root, 'calls')],
        ['GITHUB_OUTPUT', join(root, 'output')],
        ['GH_TOKEN', 'fixture-token'],
        ...values,
      ]),
    },
  );
  const read = (file: string): string =>
    existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : '';
  return { ...result, calls: read('calls'), output: read('output') };
};

describe('Dependabot auto-merge decision', () => {
  const view = `pr view ${PR_URL} --json state,headRefOid,autoMergeRequest --jq [.state, .headRefOid, (.autoMergeRequest.enabledBy.login // "")] | @tsv\n`;
  const enable = `pr merge ${PR_URL} --auto --squash\n`;
  const disable = `pr merge ${PR_URL} --disable-auto\n`;
  const decisionEnv: Env = [
    ['APP_SLUG', APP],
    ['METADATA_OUTCOME', 'success'],
    ['UPDATE_TYPE', 'version-update:semver-minor'],
    ['EVENT_ACTION', 'opened'],
    ['EVENT_SENDER', 'dependabot[bot]'],
    ['PR_URL', PR_URL],
    ['PR_HEAD', HEAD],
  ];
  const decide = (
    enabledBy: string | null,
    values: Env,
    pullRequest: Readonly<Record<string, string>> = {},
  ): Run =>
    run(
      AUTO_MERGE,
      'Apply the auto-merge decision',
      {
        'pull-request.json': {
          state: 'OPEN',
          headRefOid: HEAD,
          autoMergeRequest:
            enabledBy === null ? null : { enabledBy: { login: enabledBy } },
          ...pullRequest,
        },
      },
      [...decisionEnv, ...values],
    );
  const major: Env = [['UPDATE_TYPE', 'version-update:semver-major']];
  const cases: ReadonlyArray<readonly [string, string | null, Env, string]> = [
    ['a minor update', null, [], enable],
    [
      'a patch update',
      null,
      [['UPDATE_TYPE', 'version-update:semver-patch']],
      enable,
    ],
    ['an update it already enabled', APP, [], ''],
    ['an update a person enabled', 'maintainer', [], ''],
    ['a major update it enabled', APP, major, disable],
    ['a major update a person enabled', 'maintainer', major, ''],
    [
      'an update without a semantic version',
      APP,
      [['UPDATE_TYPE', '']],
      disable,
    ],
    [
      'an update the metadata check rejected',
      APP,
      [
        ['METADATA_OUTCOME', 'failure'],
        ['UPDATE_TYPE', ''],
      ],
      disable,
    ],
    [
      'a push by a person',
      APP,
      [
        ['EVENT_ACTION', 'synchronize'],
        ['EVENT_SENDER', 'maintainer'],
      ],
      disable,
    ],
    ['a rebase by Dependabot', null, [['EVENT_ACTION', 'synchronize']], enable],
  ];

  it.each(cases)('decides %s', (_label, enabledBy, values, change) => {
    const result = decide(enabledBy, values);
    expect(result.status).toBe(0);
    expect(result.calls).toBe(`${view}${change}`);
  });

  it('leaves a moved head to the run for that push', () => {
    const result = decide(null, [], { headRefOid: 'b'.repeat(40) });
    expect(result.status).toBe(0);
    expect(result.calls).toBe(view);
  });

  it('does nothing for a closed pull request', () => {
    const result = decide(APP, [['METADATA_OUTCOME', 'failure']], {
      state: 'CLOSED',
    });
    expect(result.status).toBe(0);
    expect(result.calls).toBe(view);
  });
});

type Enabler = { readonly __typename: string; readonly login: string };
const BOT: Enabler = { __typename: 'Bot', login: APP };
const listedPullRequest = ({
  number,
  headRefName,
  author = 'dependabot',
  enabledBy = BOT,
  state = 'SUCCESS',
  isCrossRepository = false,
}: {
  readonly number: number;
  readonly headRefName: string;
  readonly author?: string;
  readonly enabledBy?: Enabler | null;
  readonly state?: string | null;
  readonly isCrossRepository?: boolean;
}) => ({
  number,
  headRefName,
  isCrossRepository,
  author: { login: author },
  autoMergeRequest: enabledBy === null ? null : { enabledBy },
  commits: {
    nodes: [
      { commit: { statusCheckRollup: state === null ? null : { state } } },
    ],
  },
});

describe('auto-merge pull request listing', () => {
  it('lists open same-repository pull requests a bot enabled whose checks have not failed', () => {
    const nodes = [
      listedPullRequest({ number: 1, headRefName: 'dependabot/bun/a' }),
      listedPullRequest({
        number: 2,
        headRefName: 'dependabot/bun/b',
        state: 'PENDING',
      }),
      listedPullRequest({
        number: 3,
        headRefName: 'dependabot/bun/c',
        state: 'FAILURE',
      }),
      listedPullRequest({
        number: 4,
        headRefName: 'feature',
        author: 'maintainer',
        enabledBy: { __typename: 'User', login: 'maintainer' },
      }),
      listedPullRequest({
        number: 5,
        headRefName: 'feature',
        author: 'maintainer',
        enabledBy: null,
      }),
      listedPullRequest({
        number: 6,
        headRefName: 'standards-sync/update',
        author: 'other',
        state: null,
        isCrossRepository: true,
      }),
    ];
    const result = run(
      AUTO_MERGE,
      'List bot auto-merge pull requests',
      { 'pages.json': { data: { repository: { pullRequests: { nodes } } } } },
      [
        ['OWNER', 'owner'],
        ['REPOSITORY', 'repo'],
        ['BASE_REF', 'main'],
      ],
    );
    expect(result.status).toBe(0);
    expect(result.output).toBe(
      `pull-requests=${JSON.stringify(
        ['dependabot/bun/a', 'dependabot/bun/b'].map((headRefName, index) => ({
          number: index + 1,
          headRefName,
          author: 'dependabot',
          enabledBy: APP,
        })),
      )}\n`,
    );
  });
});

describe('auto-merge branch updates', () => {
  const sha = 'c'.repeat(40);
  const merge = (branch: string): string =>
    `api --include --method POST repos/owner/repo/merges -f base=${branch} -f head=${sha} -f commit_message=Merge main into ${branch} [dependabot skip]\n`;
  const update = (
    pullRequests: ReadonlyArray<Readonly<Record<string, unknown>>>,
    statuses: Readonly<Record<string, number>>,
  ): Run =>
    run(
      AUTO_MERGE,
      'Merge main into pull requests waiting to auto-merge',
      { 'statuses.json': statuses },
      [
        ['APP_SLUG', APP],
        ['PULL_REQUESTS', JSON.stringify(pullRequests)],
        ['REPOSITORY', 'owner/repo'],
        ['BASE_REF', 'main'],
        ['BASE_SHA', sha],
      ],
    );
  const entry = (
    number: number,
    headRefName: string,
    author: string,
    enabledBy = APP,
  ) => ({ number, headRefName, author, enabledBy });

  it('merges main into Dependabot and sync pull requests the broker App enabled', () => {
    const result = update(
      [
        entry(1, 'dependabot/bun/a', 'dependabot'),
        entry(2, 'standards-sync/update', APP),
        entry(3, 'dependabot/bun/c', 'dependabot'),
        entry(4, 'dependabot/bun/d', 'dependabot'),
        entry(5, 'dependabot/bun/e', 'dependabot', 'other-app'),
        entry(6, 'feature', APP),
        entry(7, 'standards-sync/update', 'other-app'),
      ],
      {
        'dependabot/bun/a': 201,
        'standards-sync/update': 204,
        'dependabot/bun/c': 409,
        'dependabot/bun/d': 404,
      },
    );
    expect(result.status).toBe(0);
    expect(result.calls).toBe(
      [
        'dependabot/bun/a',
        'standards-sync/update',
        'dependabot/bun/c',
        'dependabot/bun/d',
      ]
        .map(merge)
        .join(''),
    );
    expect(result.stdout).toContain(`Merged main at ${sha} into #1.`);
    expect(result.stdout).toContain(`#2 already contains ${sha}.`);
    expect(result.stdout).toContain('::warning::#3 conflicts with main.');
    expect(result.stdout).toContain(
      '::notice::The branch of #4 no longer exists.',
    );
  });

  it('fails after trying every pull request when a merge errors', () => {
    const result = update(
      [
        entry(1, 'dependabot/bun/a', 'dependabot'),
        entry(2, 'dependabot/bun/b', 'dependabot'),
      ],
      { 'dependabot/bun/b': 201 },
    );
    expect(result.status).toBe(1);
    expect(result.calls).toBe(
      ['dependabot/bun/a', 'dependabot/bun/b'].map(merge).join(''),
    );
    expect(result.stdout).toContain(
      '::error::Could not merge main into #1: HTTP/2.0 500 Fixture',
    );
  });
});

describe('sync pull request auto-merge', () => {
  const pullRequest = (enabledBy: string | null) => ({
    'pull-request.json': {
      autoMergeRequest:
        enabledBy === null ? null : { enabledBy: { login: enabledBy } },
    },
  });
  const enable = (
    syncPr: string,
    enabledBy: string | null,
    manual: boolean,
  ): Run =>
    run(SYNC, 'Enable sync pull request auto-merge', pullRequest(enabledBy), [
      ['APP_SLUG', APP],
      ['SYNC_PR', syncPr],
      ['SYNC_HEAD', HEAD],
      ['SYNC_MANUAL', String(manual)],
    ]);
  const view = (pr: string): string =>
    `pr view ${pr} --json autoMergeRequest --jq .autoMergeRequest.enabledBy.login // ""\n`;

  it.each([
    [
      null,
      false,
      `${view('7')}pr merge 7 --auto --squash --match-head-commit ${HEAD}\n`,
    ],
    [APP, false, view('7')],
    [APP, true, `${view('7')}pr merge 7 --disable-auto\n`],
    ['maintainer', true, view('7')],
  ] as const)(
    'decides the sync run (enabled by %p, manual: %p)',
    (enabledBy, manual, calls) => {
      const result = enable('7', enabledBy, manual);
      expect(result.status).toBe(0);
      expect(result.calls).toBe(calls);
    },
  );

  it('fails without a current sync pull request', () => {
    const result = enable('', null, false);
    expect(result.status).toBe(1);
    expect(result.calls).toBe('');
  });

  it.each([
    [`${APP}[bot]`, APP, ''],
    ['maintainer', APP, `${view(PR_URL)}pr merge ${PR_URL} --disable-auto\n`],
    ['maintainer', 'maintainer', view(PR_URL)],
  ])(
    'decides after a push by %s (enabled by %s)',
    (sender, enabledBy, calls) => {
      const result = run(
        AUTO_MERGE,
        'Turn sync auto-merge off after a push by anyone else',
        pullRequest(enabledBy),
        [
          ['APP_SLUG', APP],
          ['EVENT_SENDER', sender],
          ['PR_URL', PR_URL],
        ],
      );
      expect(result.status).toBe(0);
      expect(result.calls).toBe(calls);
    },
  );
});
