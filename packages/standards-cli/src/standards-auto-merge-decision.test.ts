import { afterEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { cleanupTmpDirs } from './cli-test-support';
import {
  APP,
  AUTO_MERGE,
  autoMergeGate,
  autoMergeSetting,
  disableRecord,
  type Env,
  HEAD,
  PR_URL,
  type Run,
  readAutoMergeSetting,
  readDisables,
  readRequiredChecks,
  stepRunner,
} from './standards-auto-merge-test-support';

afterEach(cleanupTmpDirs);

const run = stepRunner(process.env);

type ListedCommit = {
  readonly sha: string;
  readonly login: string;
  readonly committer?: string;
  readonly parents?: number;
  readonly verified?: boolean;
};
// GitHub commits Dependabot's commits as web-flow.
const listedCommit = ({
  sha,
  login,
  committer = 'web-flow',
  parents = 1,
  verified = true,
}: ListedCommit) => ({
  sha,
  author: { login },
  committer: { login: committer },
  commit: { verification: { verified } },
  parents: Array.from({ length: parents }, (_, index) => ({
    sha: String(index).repeat(40),
  })),
});
const DEPENDABOT_COMMIT = listedCommit({
  sha: 'd'.repeat(40),
  login: 'dependabot[bot]',
});
// The App's merges from main may name GitHub or the App as committer.
const APP_MERGE = listedCommit({ sha: HEAD, login: `${APP}[bot]`, parents: 2 });
const SELF_COMMITTED_APP_MERGE = listedCommit({
  sha: 'c'.repeat(40),
  login: `${APP}[bot]`,
  committer: `${APP}[bot]`,
  parents: 2,
});

const view = `pr view ${PR_URL} --json state,headRefOid,autoMergeRequest --jq [.state, .headRefOid, (.autoMergeRequest.enabledBy.login // "")] | @tsv\n`;
const list = 'api --paginate repos/owner/repo/pulls/12/commits\n';
const readGate = `${readDisables(12)}${readAutoMergeSetting}${readRequiredChecks}`;
const enable = `${readGate}pr merge ${PR_URL} --auto --squash --match-head-commit ${HEAD}\n`;
const disable = `pr merge ${PR_URL} --disable-auto\n`;
const decisionEnv: Env = [
  ['APP_SLUG', APP],
  ['METADATA_OUTCOME', 'success'],
  ['UPDATE_TYPE', 'version-update:semver-minor'],
  ['REPOSITORY', 'owner/repo'],
  ['BASE_REF', 'main'],
  ['PR_NUMBER', '12'],
  ['PR_URL', PR_URL],
];
const decide = (
  enabledBy: string | null,
  values: Env,
  {
    pullRequest = {},
    commitPages = [[DEPENDABOT_COMMIT, SELF_COMMITTED_APP_MERGE], [APP_MERGE]],
    disabled = false,
    gate = autoMergeGate(),
  }: {
    readonly pullRequest?: Readonly<Record<string, string>>;
    readonly commitPages?: ReadonlyArray<ReadonlyArray<unknown>>;
    readonly disabled?: boolean;
    readonly gate?: Readonly<Record<string, unknown>>;
  } = {},
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
      'commit-pages.json': commitPages,
      ...disableRecord(disabled),
      ...gate,
    },
    [...decisionEnv, ...values],
  );

describe('Dependabot auto-merge decision', () => {
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
  ];

  it.each(cases)('decides %s', (_label, enabledBy, values, change) => {
    const result = decide(enabledBy, values);
    expect(result.status).toBe(0);
    expect(result.calls).toBe(`${view}${list}${change}`);
  });

  // fetch-metadata verifies only the first commit, and a reopen names nobody
  // who pushed, so only the full commit list shows the others.
  it('keeps a reopened pull request with commits from someone else manual', () => {
    const others = [
      listedCommit({ sha: 'e'.repeat(40), login: 'maintainer' }),
      listedCommit({
        sha: 'f'.repeat(40),
        login: 'dependabot[bot]',
        verified: false,
      }),
      listedCommit({ sha: '1'.repeat(40), login: `${APP}[bot]` }),
    ];
    const result = decide(APP, [], {
      commitPages: [[DEPENDABOT_COMMIT, ...others], [APP_MERGE]],
    });
    expect(result.status).toBe(0);
    expect(result.calls).toBe(`${view}${list}${disable}`);
    expect(result.stdout).toContain(
      `::notice::Turned auto-merge off because it has commits that are neither verified Dependabot commits nor broker App merges: ${others.map(({ sha }) => sha).join(' ')}.`,
    );
  });

  // A clean rebase or a later update can make every commit look like the
  // bots' again, but it cannot erase GitHub's record of the disable.
  it('keeps an eligible update manual once its auto-merge was turned off', () => {
    const result = decide(null, [], { disabled: true });
    expect(result.status).toBe(0);
    expect(result.calls).toBe(`${view}${list}${readDisables(12)}`);
    expect(result.stdout).toContain(
      'Left this pull request manual because its auto-merge was turned off before.',
    );
  });

  // A maintainer who amends or cherry-picks a bot's commit and signs it with
  // their own key keeps the bot as author but becomes the committer.
  it('keeps a pull request manual when someone else committed a bot commit', () => {
    const recommitted = [
      listedCommit({
        sha: 'e'.repeat(40),
        login: 'dependabot[bot]',
        committer: 'maintainer',
      }),
      listedCommit({
        sha: 'f'.repeat(40),
        login: `${APP}[bot]`,
        committer: 'maintainer',
        parents: 2,
      }),
    ];
    const result = decide(APP, [], {
      commitPages: [[DEPENDABOT_COMMIT, ...recommitted], [APP_MERGE]],
    });
    expect(result.status).toBe(0);
    expect(result.calls).toBe(`${view}${list}${disable}`);
    expect(result.stdout).toContain(
      `nor broker App merges: ${recommitted.map(({ sha }) => sha).join(' ')}.`,
    );
  });

  it('leaves a pull request manual when its commit list does not end at its head', () => {
    const result = decide(APP, [], {
      pullRequest: { headRefOid: 'b'.repeat(40) },
    });
    expect(result.status).toBe(0);
    expect(result.calls).toBe(`${view}${list}${disable}`);
  });

  it('does nothing for a closed pull request', () => {
    const result = decide(APP, [['METADATA_OUTCOME', 'failure']], {
      pullRequest: { state: 'CLOSED' },
    });
    expect(result.status).toBe(0);
    expect(result.calls).toBe(view);
  });
});

describe('Dependabot auto-merge gate', () => {
  // gh merges a pull request that nothing holds at once instead of turning
  // its auto-merge on, so an update merges itself only where a rule makes it
  // wait for `check`.
  it.each([
    [
      "doesn't allow auto-merge",
      autoMergeGate({ allowed: false }),
      `${readDisables(12)}${readAutoMergeSetting}`,
      "this repository doesn't allow auto-merge",
    ],
    [
      'has no rule that requires check',
      autoMergeGate({ required: ['lint'] }),
      readGate,
      'no active rule on main requires check',
    ],
  ])(
    'keeps an eligible update manual where the repository %s',
    (_label, gate, reads, reason) => {
      const result = decide(null, [], { gate });
      expect(result.status).toBe(0);
      expect(result.calls).toBe(`${view}${list}${reads}`);
      expect(result.stdout).toContain(
        `Left this pull request manual because ${reason}.`,
      );
    },
  );

  it('fails without turning auto-merge on when the branch rules are unreadable', () => {
    const result = decide(null, [], {
      gate: autoMergeSetting(true),
    });
    expect(result.status).not.toBe(0);
    expect(result.calls).toBe(`${view}${list}${readGate}`);
  });
});
