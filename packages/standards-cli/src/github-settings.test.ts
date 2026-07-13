import { describe, expect, it } from 'bun:test';
import { loadGithubSettings } from './github-settings';

const canonicalEnvironment = JSON.parse(
  '{"name":"standards-sync","wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true},"deployment_branch_policies":[{"name":"main","type":"branch"}]}',
) as Record<string, unknown>;

const canonical = JSON.stringify({
  repository: { allow_auto_merge: true },
  rulesets: [{ name: 'Protect main', target: 'branch' }],
  environments: [canonicalEnvironment],
});

const emptySeam = JSON.stringify({
  repository: {},
  rulesets: [],
  environments: [],
});

describe('loadGithubSettings', () => {
  it('merges an additive seam', () => {
    const local = JSON.stringify({
      repository: { has_wiki: false },
      rulesets: [{ name: 'Protect releases', target: 'branch' }],
      environments: [
        JSON.parse(
          '{"name":"production","wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false},"deployment_branch_policies":[]}',
        ),
      ],
    });
    const loaded = loadGithubSettings(canonical, local);
    expect(loaded.problems).toEqual([]);
    expect(loaded.merged?.repository).toEqual({
      allow_auto_merge: true,
      has_wiki: false,
    });
    expect(loaded.merged?.rulesets.map((r) => r.name)).toEqual([
      'Protect main',
      'Protect releases',
    ]);
    expect(
      loaded.merged?.environments.map((environment) => environment.name),
    ).toEqual(['standards-sync', 'production']);
  });

  it('requires the local seam to exist', () => {
    const loaded = loadGithubSettings(canonical, null);
    expect(loaded.merged).toBeNull();
    expect(loaded.problems).toEqual([
      '.github/settings.local.json must exist; seed it with {"repository":{},"rulesets":[],"environments":[]}',
    ]);
  });

  it('rejects overriding a canonical repository key and redefining a canonical ruleset together', () => {
    const local = JSON.stringify({
      repository: { allow_auto_merge: false },
      rulesets: [{ name: 'Protect main' }],
      environments: [canonicalEnvironment],
    });
    const loaded = loadGithubSettings(canonical, local);
    expect(loaded.merged).toBeNull();
    expect(loaded.problems).toEqual([
      '.github/settings.local.json repository."allow_auto_merge" would override a canonical value; canonical settings are read-only',
      '.github/settings.local.json ruleset "Protect main" collides with a canonical ruleset; add a separately named ruleset to tighten further',
      '.github/settings.local.json environment "standards-sync" collides with a canonical environment; canonical settings are read-only',
    ]);
  });

  it('gathers structural problems from both files', () => {
    const badCanonical = JSON.stringify({
      repositories: {},
      rulesets: [{ target: 'branch' }, { name: 'Dup' }, { name: 'Dup' }],
    });
    const badLocal = JSON.stringify({ rulesets: 'nope' });
    const loaded = loadGithubSettings(badCanonical, badLocal);
    expect(loaded.merged).toBeNull();
    expect(loaded.problems).toEqual([
      '.github/settings.json has unknown key "repositories"',
      '.github/settings.json rulesets[0] must be an object with a non-empty "name"',
      '.github/settings.json declares ruleset "Dup" more than once',
      '.github/settings.local.json "rulesets" must be an array',
    ]);
  });

  it('reports invalid JSON per file', () => {
    const loaded = loadGithubSettings('{', 'also not json');
    expect(loaded.merged).toBeNull();
    expect(loaded.problems).toEqual([
      '.github/settings.json must contain valid JSON',
      '.github/settings.local.json must contain valid JSON',
    ]);
  });

  it('accepts the empty seam', () => {
    const loaded = loadGithubSettings(canonical, emptySeam);
    expect(loaded.problems).toEqual([]);
    expect(loaded.merged?.rulesets).toHaveLength(1);
  });
});

describe('environment settings validation', () => {
  it('rejects malformed environment protection and deployment policy data', () => {
    const malformed = JSON.parse(
      '{"name":"standards-sync","wait_timer":-1,"prevent_self_review":"no","reviewers":{},"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":true},"deployment_branch_policies":[{"name":"","type":"branch"}]}',
    );
    const loaded = loadGithubSettings(
      JSON.stringify({ environments: [malformed] }),
      emptySeam,
    );
    expect(loaded.merged).toBeNull();
    expect(loaded.problems).toEqual([
      '.github/settings.json environments[0].wait_timer must be a non-negative integer',
      '.github/settings.json environments[0].prevent_self_review must be a boolean',
      '.github/settings.json environments[0].reviewers must be an array',
      '.github/settings.json environments[0].deployment_branch_policy must enable exactly one branch-policy mode',
      '.github/settings.json environments[0].deployment_branch_policies[0] must have a non-empty name and type "branch" or "tag"',
    ]);
  });
});
