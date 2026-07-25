import { describe, expect, it } from 'bun:test';
import {
  BYPASS_ACTORS_KEY,
  diffRuleset,
  diffRulesets,
} from './github-ruleset-diff';

// Fixtures come through JSON.parse so the snake_case keys the GitHub API uses
// stay literal payloads rather than identifiers.

// A live ruleset as the API returns it: declared config plus server fields.
const liveRuleset = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ...(JSON.parse(
    '{"id":42,"node_id":"RRS_x","source_type":"Repository","source":"owner/repo","created_at":"2026-01-01T00:00:00Z","name":"Protect main","target":"branch","enforcement":"active","conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},"bypass_actors":[],"rules":[{"type":"deletion"},{"type":"pull_request","parameters":{"required_approving_review_count":0,"allowed_merge_methods":["squash"],"some_future_github_default":true}}]}',
  ) as Record<string, unknown>),
  ...overrides,
});

const declaredRuleset = JSON.parse(
  '{"name":"Protect main","target":"branch","enforcement":"active","conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},"bypass_actors":[],"rules":[{"type":"deletion"},{"type":"pull_request","parameters":{"required_approving_review_count":0,"allowed_merge_methods":["squash"]}}]}',
) as Record<string, unknown>;

const actor = JSON.parse('{"actor_id":5,"actor_type":"RepositoryRole"}') as {
  readonly actor_id: number;
};

const changedRules = JSON.parse(
  '[{"type":"pull_request","parameters":{"required_approving_review_count":1,"allowed_merge_methods":["squash"]}},{"type":"creation"}]',
) as ReadonlyArray<unknown>;

describe('diffRuleset', () => {
  it('accepts a live ruleset with extra server fields and parameters', () => {
    expect(diffRuleset(declaredRuleset, liveRuleset())).toEqual({
      drifted: [],
      unverifiable: [],
    });
  });

  it('flags an added bypass actor as drift and reports both counts', () => {
    const live = liveRuleset({ [BYPASS_ACTORS_KEY]: [actor] });
    expect(diffRuleset(declaredRuleset, live).drifted).toEqual([
      'ruleset "Protect main": bypass_actors differs from the declared configuration (GitHub reports 1 bypass actor(s); 0 declared)',
    ]);
  });

  // Equal lengths mean the identities differ; the counts would only repeat
  // themselves.
  it('omits the counts when the lists differ only in identity', () => {
    const declared = { ...declaredRuleset, [BYPASS_ACTORS_KEY]: [actor] };
    const live = liveRuleset({
      [BYPASS_ACTORS_KEY]: [{ ...actor, actor_id: 9 }],
    });
    expect(diffRuleset(declared, live).drifted).toEqual([
      'ruleset "Protect main": bypass_actors differs from the declared configuration',
    ]);
  });

  it('treats fields the token cannot see as unverifiable, not drift', () => {
    // Non-admin API responses omit bypass_actors entirely.
    const live = Object.fromEntries(
      Object.entries(liveRuleset()).filter(
        ([key]) => key !== BYPASS_ACTORS_KEY,
      ),
    );
    const diff = diffRuleset(declaredRuleset, live);
    expect(diff.drifted).toEqual([]);
    expect(diff.unverifiable).toEqual([
      { key: BYPASS_ACTORS_KEY, name: 'Protect main' },
    ]);
  });

  it('flags a missing rule, a changed parameter, and an extra rule', () => {
    const { drifted } = diffRuleset(
      declaredRuleset,
      liveRuleset({ rules: changedRules }),
    );
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

  // Nothing on GitHub's side makes repository ruleset names unique. Keying the
  // live side by name alone would compare the clean twin, pass, and never
  // mention that the other one grants a bypass on the same branch.
  it('fails on colliding live ruleset names instead of picking one', () => {
    const bypassed = liveRuleset({ id: 7, [BYPASS_ACTORS_KEY]: [actor] });
    const clean = liveRuleset({ id: 8 });
    const { drifted, unverifiable } = diffRulesets(
      [declaredRuleset],
      [bypassed, clean],
    );
    expect(drifted).toEqual([
      'ruleset name "Protect main" is used by 2 rulesets on GitHub (ids 7, 8); the declaration addresses rulesets by name, so none of them can be verified until all but one is renamed or deleted',
    ]);
    expect(unverifiable).toEqual([]);
  });

  it('reports a colliding name that is not declared at all', () => {
    const { drifted } = diffRulesets(
      [declaredRuleset],
      [
        liveRuleset(),
        liveRuleset({ id: 7, name: 'Handmade rules' }),
        liveRuleset({ id: 8, name: 'Handmade rules' }),
      ],
    );
    expect(drifted).toContain(
      'ruleset name "Handmade rules" is used by 2 rulesets on GitHub (ids 7, 8); the declaration addresses rulesets by name, so none of them can be verified until all but one is renamed or deleted',
    );
    expect(drifted).toContain(
      'ruleset "Handmade rules" exists on GitHub but is not declared; declare it in .github/settings.local.json or delete it',
    );
  });
});
