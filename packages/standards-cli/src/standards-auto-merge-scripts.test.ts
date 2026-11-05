import { afterEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { cleanupTmpDirs } from './cli-test-support';
import {
  APP,
  AUTO_MERGE,
  autoMergeGate,
  autoMergeSetting,
  type Env,
  HEAD,
  PR_URL,
  type Run,
  readAutoMergeSetting,
  readRequiredChecks,
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

const pullRequest = (enabledBy: string | null) => ({
  'pull-request.json': {
    autoMergeRequest:
      enabledBy === null ? null : { enabledBy: { login: enabledBy } },
  },
});
const enable = (
  syncPr: string,
  enabledBy: string | null,
  {
    created = false,
    manual = false,
    gate = autoMergeGate(),
  }: {
    readonly created?: boolean;
    readonly manual?: boolean;
    readonly gate?: Readonly<Record<string, unknown>>;
  } = {},
): Run =>
  run(
    SYNC,
    'Enable sync pull request auto-merge',
    { ...pullRequest(enabledBy), ...gate },
    [
      ['APP_SLUG', APP],
      ['REPOSITORY', 'owner/repo'],
      ['BASE_REF', 'main'],
      ['PR_NUMBER', syncPr],
      ['PR_CREATED', String(created)],
      ['SYNC_HEAD', HEAD],
      ['SYNC_MANUAL', String(manual)],
    ],
  );

describe('sync pull request auto-merge', () => {
  const view = (pr: string): string =>
    `pr view ${pr} --json autoMergeRequest --jq .autoMergeRequest.enabledBy.login // ""\n`;

  it.each([
    {
      created: true,
      enabledBy: null,
      manual: false,
      calls: `${readAutoMergeSetting}${readRequiredChecks}pr merge 7 --auto --squash --match-head-commit ${HEAD}\n`,
    },
    {
      created: false,
      enabledBy: APP,
      manual: true,
      calls: `${view('7')}pr merge 7 --disable-auto\n`,
    },
    { created: false, enabledBy: 'maintainer', manual: true, calls: view('7') },
    { created: false, enabledBy: APP, manual: false, calls: '' },
    // The open pull request closed after this run kept commits from others.
    { created: true, enabledBy: null, manual: true, calls: view('7') },
  ])(
    'decides the sync run (created: $created, enabled by $enabledBy, manual: $manual)',
    ({ created, enabledBy, manual, calls }) => {
      const result = enable('7', enabledBy, { created, manual });
      expect(result.status).toBe(0);
      expect(result.calls).toBe(calls);
    },
  );

  // A maintainer amends the bot commit of a pull request whose auto-merge was
  // never on, and a clean rebase makes the bot its committer again. The run
  // that reuses the pull request then sees only bot commits and no turned-off
  // auto-merge.
  it('leaves auto-merge off on a sync pull request an earlier run opened', () => {
    const result = enable('7', null);
    expect(result.status).toBe(0);
    expect(result.calls).toBe('');
  });

  it('fails without a current sync pull request', () => {
    const result = enable('', null);
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

describe('sync pull request auto-merge gate', () => {
  // gh merges a pull request that nothing holds at once instead of turning
  // its auto-merge on, so the sync pull request merges itself only where a
  // rule makes it wait for `check`.
  it.each([
    [
      "doesn't allow auto-merge",
      autoMergeGate({ allowed: false }),
      readAutoMergeSetting,
      "This repository doesn't allow auto-merge, so standards sync PR #7 stays manual.",
    ],
    [
      'has no rule that requires check',
      autoMergeGate({ required: [] }),
      `${readAutoMergeSetting}${readRequiredChecks}`,
      'No active rule on main requires check, so standards sync PR #7 stays manual.',
    ],
  ])(
    'keeps a new sync pull request manual where the repository %s',
    (_label, gate, calls, message) => {
      const result = enable('7', null, { created: true, gate });
      expect(result.status).toBe(0);
      expect(result.calls).toBe(calls);
      expect(result.stdout).toContain(message);
    },
  );

  it('fails without turning auto-merge on when the branch rules are unreadable', () => {
    const result = enable('7', null, {
      created: true,
      gate: autoMergeSetting(true),
    });
    expect(result.status).not.toBe(0);
    expect(result.calls).toBe(`${readAutoMergeSetting}${readRequiredChecks}`);
  });
});
