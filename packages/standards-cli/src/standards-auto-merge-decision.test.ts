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
  stepRunner,
} from './standards-auto-merge-test-support';

afterEach(cleanupTmpDirs);

const run = stepRunner(process.env);

type ListedCommit = {
  readonly sha: string;
  readonly login: string;
  readonly parents?: number;
  readonly verified?: boolean;
};
const listedCommit = ({
  sha,
  login,
  parents = 1,
  verified = true,
}: ListedCommit) => ({
  sha,
  author: { login },
  commit: { verification: { verified } },
  parents: Array.from({ length: parents }, (_, index) => ({
    sha: String(index).repeat(40),
  })),
});
const DEPENDABOT_COMMIT = listedCommit({
  sha: 'd'.repeat(40),
  login: 'dependabot[bot]',
});
const APP_MERGE = listedCommit({ sha: HEAD, login: `${APP}[bot]`, parents: 2 });

const view = `pr view ${PR_URL} --json state,headRefOid,autoMergeRequest --jq [.state, .headRefOid, (.autoMergeRequest.enabledBy.login // "")] | @tsv\n`;
const list = 'api --paginate repos/owner/repo/pulls/12/commits\n';
const enable = `${readDisables(12)}pr merge ${PR_URL} --auto --squash --match-head-commit ${HEAD}\n`;
const disable = `pr merge ${PR_URL} --disable-auto\n`;
const decisionEnv: Env = [
  ['APP_SLUG', APP],
  ['METADATA_OUTCOME', 'success'],
  ['UPDATE_TYPE', 'version-update:semver-minor'],
  ['REPOSITORY', 'owner/repo'],
  ['PR_NUMBER', '12'],
  ['PR_URL', PR_URL],
];
const decide = (
  enabledBy: string | null,
  values: Env,
  {
    pullRequest = {},
    commitPages = [[DEPENDABOT_COMMIT], [APP_MERGE]],
    disabled = 0,
  }: {
    readonly pullRequest?: Readonly<Record<string, string>>;
    readonly commitPages?: ReadonlyArray<ReadonlyArray<unknown>>;
    readonly disabled?: number;
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
    const result = decide(null, [], { disabled: 1 });
    expect(result.status).toBe(0);
    expect(result.calls).toBe(`${view}${list}${readDisables(12)}`);
    expect(result.stdout).toContain(
      'Left this pull request manual because its auto-merge was turned off before.',
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
