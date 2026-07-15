import { describe, expect, it } from 'bun:test';
import { diffGithubLiveState } from './github-live-state-diff';
import { decodeLiveRepositorySettings } from './github-repository-settings';
import type { GithubSettings } from './github-settings-value';

const MALFORMED_KEY = 'allow_auto_merge';
const DRIFTED_KEY = 'allow_merge_commit';
const HIDDEN_KEY = 'delete_branch_on_merge';

describe('combined repository response state', () => {
  it('reports malformed state once while retaining independent drift and unverifiable keys', () => {
    const declared: GithubSettings = {
      defaultBranchProtection: null,
      environments: [],
      immutableReleases: null,
      repository: {
        [DRIFTED_KEY]: true,
        [HIDDEN_KEY]: true,
        [MALFORMED_KEY]: true,
      },
      rulesets: [],
    };
    const decoded = decodeLiveRepositorySettings(
      { [DRIFTED_KEY]: false, [MALFORMED_KEY]: 'true' },
      declared.repository,
      false,
    );

    expect(
      diffGithubLiveState(declared, {
        defaultBranch: null,
        environments: [],
        immutableReleases: null,
        problems: decoded.problems,
        repository: decoded.settings,
        repositoryInvalidKeys: decoded.invalidKeys,
        rulesets: { problem: null, rulesets: [] },
      }),
    ).toEqual({
      drifted: [
        `GitHub repository response."${MALFORMED_KEY}" must be a boolean`,
        `repository setting "${DRIFTED_KEY}" is false on GitHub, declared true`,
      ],
      unverifiable: [HIDDEN_KEY],
    });
  });
});
