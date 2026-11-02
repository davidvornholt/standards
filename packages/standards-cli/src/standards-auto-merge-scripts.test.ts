import { afterEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { cleanupTmpDirs } from './cli-test-support';
import {
  APP,
  AUTO_MERGE,
  disableRecord,
  type Env,
  HEAD,
  PR_URL,
  type Run,
  readDisables,
  SYNC,
  stepRunner,
} from './standards-auto-merge-test-support';

afterEach(cleanupTmpDirs);

const run = stepRunner(process.env);

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

const list = (nodes: ReadonlyArray<unknown>, values: Env = []): Run =>
  run(
    AUTO_MERGE,
    'List bot auto-merge pull requests',
    { 'pages.json': { data: { repository: { pullRequests: { nodes } } } } },
    [
      ['OWNER', 'owner'],
      ['REPOSITORY', 'repo'],
      ['BASE_REF', 'main'],
      ['PR_NUMBER', ''],
      ...values,
    ],
  );

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
    const result = list(nodes);
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

  it('brings a pull request up to date when its auto-merge is enabled after the push scan', () => {
    const listed = list(
      [
        listedPullRequest({ number: 1, headRefName: 'dependabot/bun/a' }),
        listedPullRequest({ number: 2, headRefName: 'dependabot/bun/b' }),
      ],
      [['PR_NUMBER', '2']],
    );
    expect(listed.status).toBe(0);
    const result = update(
      JSON.parse(listed.output.slice('pull-requests='.length)),
      { 'dependabot/bun/b': 201 },
    );
    expect(result.calls).toBe(merge('dependabot/bun/b'));
    expect(result.status).toBe(0);
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
    disabled = false,
  ): Run =>
    run(
      SYNC,
      'Enable sync pull request auto-merge',
      { ...pullRequest(enabledBy), ...disableRecord(disabled) },
      [
        ['APP_SLUG', APP],
        ['REPOSITORY', 'owner/repo'],
        ['PR_NUMBER', syncPr],
        ['SYNC_HEAD', HEAD],
        ['SYNC_MANUAL', String(manual)],
      ],
    );
  const view = (pr: string): string =>
    `pr view ${pr} --json autoMergeRequest --jq .autoMergeRequest.enabledBy.login // ""\n`;

  it.each([
    [
      null,
      false,
      `${view('7')}${readDisables(7)}pr merge 7 --auto --squash --match-head-commit ${HEAD}\n`,
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

  // A clean rebase rewrites the committer that showed a maintainer's commit,
  // so the next run sees only bot commits. GitHub's record of the disable
  // stays.
  it('keeps a sync pull request manual once its auto-merge was turned off', () => {
    const result = enable('7', null, false, true);
    expect(result.status).toBe(0);
    expect(result.calls).toBe(`${view('7')}${readDisables(7)}`);
  });

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
