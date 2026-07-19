import { describe, expect, it } from 'bun:test';
import {
  diffRepositorySettings,
  diffRuleset,
  diffRulesets,
  subsetMatches,
} from './github-diff';

// A live ruleset as the API returns it: declared config plus server fields.
const liveRuleset = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: 42,
  node_id: 'RRS_x',
  source_type: 'Repository',
  source: 'owner/repo',
  created_at: '2026-01-01T00:00:00Z',
  name: 'Protect main',
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  bypass_actors: [],
  rules: [
    { type: 'deletion' },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 0,
        allowed_merge_methods: ['squash'],
        some_future_github_default: true,
      },
    },
  ],
  ...overrides,
});

const declaredRuleset: Record<string, unknown> = {
  name: 'Protect main',
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  bypass_actors: [],
  rules: [
    { type: 'deletion' },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 0,
        allowed_merge_methods: ['squash'],
      },
    },
  ],
};

describe('subsetMatches', () => {
  it('ignores extra keys on the live side', () => {
    expect(subsetMatches({ a: 1 }, { a: 1, b: 2 })).toBe(true);
  });

  it('rejects a changed nested value', () => {
    expect(subsetMatches({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
  });

  it('matches arrays regardless of order but not length', () => {
    expect(subsetMatches(['squash', 'rebase'], ['rebase', 'squash'])).toBe(
      true,
    );
    expect(subsetMatches([], ['added'])).toBe(false);
    expect(subsetMatches(['squash'], ['squash', 'rebase'])).toBe(false);
  });
});

describe('diffRuleset', () => {
  it('accepts a live ruleset with extra server fields and parameters', () => {
    expect(diffRuleset(declaredRuleset, liveRuleset())).toEqual({
      drifted: [],
      unverifiable: [],
    });
  });

  it('flags an added bypass actor as drift', () => {
    const live = liveRuleset({
      bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole' }],
    });
    expect(diffRuleset(declaredRuleset, live).drifted).toEqual([
      'ruleset "Protect main": bypass_actors differs from the declared configuration',
    ]);
  });

  it('treats fields the token cannot see as unverifiable, not drift', () => {
    // Non-admin API responses omit bypass_actors entirely.
    const live = Object.fromEntries(
      Object.entries(liveRuleset()).filter(([key]) => key !== 'bypass_actors'),
    );
    const diff = diffRuleset(declaredRuleset, live);
    expect(diff.drifted).toEqual([]);
    expect(diff.unverifiable).toEqual([
      'ruleset "Protect main": bypass_actors',
    ]);
  });

  it('flags a missing rule, a changed parameter, and an extra rule', () => {
    const live = liveRuleset({
      rules: [
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 1,
            allowed_merge_methods: ['squash'],
          },
        },
        { type: 'creation' },
      ],
    });
    const { drifted } = diffRuleset(declaredRuleset, live);
    expect(drifted).toContain(
      'ruleset "Protect main": missing rule "deletion"',
    );
    expect(drifted).toContain(
      'ruleset "Protect main": rule "pull_request" differs from the declared configuration',
    );
    expect(drifted).toContain(
      'ruleset "Protect main": has undeclared extra rule "creation"',
    );
  });

  it('flags a disabled enforcement', () => {
    const live = liveRuleset({ enforcement: 'disabled' });
    expect(diffRuleset(declaredRuleset, live).drifted).toEqual([
      'ruleset "Protect main": enforcement differs from the declared configuration',
    ]);
  });
});

describe('diffRulesets', () => {
  it('flags declared-but-missing and live-but-undeclared rulesets', () => {
    const { drifted } = diffRulesets(
      [declaredRuleset],
      [liveRuleset({ name: 'Handmade rules' })],
    );
    expect(drifted).toContain(
      'ruleset "Protect main" is declared but missing on GitHub',
    );
    expect(drifted).toContain(
      'ruleset "Handmade rules" exists on GitHub but is not declared; declare it in .github/settings.local.json or delete it',
    );
  });

  it('is empty when live state matches exactly', () => {
    expect(diffRulesets([declaredRuleset], [liveRuleset()])).toEqual({
      drifted: [],
      unverifiable: [],
    });
  });
});

describe('diffRepositorySettings', () => {
  it('separates drifted from unverifiable settings', () => {
    const declared = { allow_auto_merge: true, delete_branch_on_merge: true };
    const live = { allow_auto_merge: false };
    const diff = diffRepositorySettings(declared, live);
    expect(diff.drifted).toEqual([
      'repository setting "allow_auto_merge" is false on GitHub, declared true',
    ]);
    expect(diff.unverifiable).toEqual(['delete_branch_on_merge']);
  });
});
