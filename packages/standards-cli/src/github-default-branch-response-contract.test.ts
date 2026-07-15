import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { decodeDefaultBranchProtection } from './github-default-branch-response';
import { diffGithubLiveState } from './github-live-state-diff';

const DEFAULT_BRANCH_PROTECTION = 'default_branch_protection';
const REQUIRED_REVIEWS = 'required_pull_request_reviews';
const REQUIRED_CHECKS = 'required_status_checks';
const declared = JSON.parse(
  await readFile(
    new URL('../../../.github/settings.json', import.meta.url),
    'utf8',
  ),
)[DEFAULT_BRANCH_PROTECTION] as Record<string, unknown>;

const wrappers = (): Record<string, unknown> =>
  JSON.parse(
    '{"allow_deletions":{"enabled":false},"allow_force_pushes":{"enabled":false},"allow_fork_syncing":{"enabled":false},"block_creations":{"enabled":false},"enforce_admins":{"enabled":true},"lock_branch":{"enabled":false},"required_conversation_resolution":{"enabled":true},"required_linear_history":{"enabled":true},"required_signatures":{"enabled":false}}',
  ) as Record<string, unknown>;

describe('optional classic protection sections', () => {
  it.each([
    undefined,
    null,
  ])('normalizes absent or null status checks and reviews to disabled state', (disabled) => {
    const body = wrappers();
    if (disabled !== undefined) {
      body[REQUIRED_CHECKS] = disabled;
      body[REQUIRED_REVIEWS] = disabled;
    }
    const decoded = decodeDefaultBranchProtection(body);
    expect(decoded.problem).toBeNull();
    expect(decoded.value?.[REQUIRED_REVIEWS]).toBeNull();
    expect(decoded.value?.[REQUIRED_CHECKS]).toBeNull();
  });

  it.each([
    ['required_status_checks', {}],
    ['required_pull_request_reviews', {}],
  ] as const)('rejects malformed present %s', (key, malformed) => {
    expect(
      decodeDefaultBranchProtection({ ...wrappers(), [key]: malformed }),
    ).toEqual({
      problem: 'GitHub returned an invalid default-branch protection response',
      value: null,
    });
  });

  it('reports disabled optional sections as semantic drift', () => {
    const protection = decodeDefaultBranchProtection(wrappers()).value;
    expect(protection).not.toBeNull();
    expect(
      diffGithubLiveState(
        {
          defaultBranchProtection: declared,
          environments: [],
          immutableReleases: null,
          repository: {},
          rulesets: [],
        },
        {
          defaultBranch: {
            branch: 'main',
            classicProtection: true,
            problem: null,
            protection,
            unverifiable: false,
          },
          environments: [],
          immutableReleases: null,
          problems: [],
          repository: {},
          repositoryInvalidKeys: new Set(),
          rulesets: { problem: null, rulesets: [] },
        },
      ).drifted,
    ).toEqual([
      'default branch "main" protection differs from the declaration',
    ]);
  });
});
