import { describe, expect, it } from 'bun:test';
import { declaredRuleset } from './github-ruleset-test-fixture';
import { loadGithubSettings } from './github-settings';

const canonicalEnvironment = JSON.parse(
  '{"name":"standards-sync","wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false}}',
) as Record<string, unknown>;
const canonical = JSON.stringify({
  repository: { allow_auto_merge: true },
  rulesets: [declaredRuleset('Protect main')],
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
      rulesets: [declaredRuleset('Protect releases')],
      environments: [
        JSON.parse(
          '{"name":"production","wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false}}',
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
      rulesets: [declaredRuleset('Protect main')],
      environments: [{ ...canonicalEnvironment, name: 'Standards-Sync' }],
    });
    const loaded = loadGithubSettings(canonical, local);
    expect(loaded.merged).toBeNull();
    expect(loaded.problems).toEqual([
      '.github/settings.local.json repository."allow_auto_merge" would override a canonical value; canonical settings are read-only',
      '.github/settings.local.json ruleset "Protect main" collides with a canonical ruleset; add a separately named ruleset to tighten further',
      '.github/settings.local.json environment "Standards-Sync" collides with a canonical environment; canonical settings are read-only',
    ]);
  });

  it('gathers structural problems from both files', () => {
    const badCanonical = JSON.stringify({
      repositories: {},
      rulesets: [
        { target: 'branch' },
        declaredRuleset('Dup'),
        declaredRuleset('Dup'),
      ],
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

  it('rejects mixed-case duplicate environment identities', () => {
    const loaded = loadGithubSettings(
      JSON.stringify({
        environments: [
          canonicalEnvironment,
          { ...canonicalEnvironment, name: 'Standards-Sync' },
        ],
      }),
      emptySeam,
    );

    expect(loaded.merged).toBeNull();
    expect(loaded.problems).toEqual([
      '.github/settings.json declares environment "Standards-Sync" more than once',
    ]);
  });
});

describe('default branch protection ownership', () => {
  it('reserves default-branch protection for the canonical owner', () => {
    const protection = JSON.parse(
      '{"allow_deletions":false,"allow_force_pushes":false,"allow_fork_syncing":false,"block_creations":false,"enforce_admins":true,"lock_branch":false,"required_conversation_resolution":true,"required_linear_history":true,"required_pull_request_reviews":{"bypass_pull_request_allowances":{"apps":[],"teams":[],"users":[]},"dismiss_stale_reviews":true,"require_code_owner_reviews":false,"require_last_push_approval":false,"required_approving_review_count":0},"required_signatures":false,"required_status_checks":{"checks":[{"app_id":15368,"context":"check"}],"strict":true},"restrictions":null}',
    ) as unknown;
    const loaded = loadGithubSettings(
      JSON.stringify({ default_branch_protection: protection }),
      JSON.stringify({ default_branch_protection: protection }),
    );
    expect(loaded.merged).toBeNull();
    expect(loaded.problems).toContain(
      '.github/settings.local.json default_branch_protection cannot override the canonical default-branch owner; add a local ruleset to tighten policy',
    );
  });
});

describe('environment settings validation', () => {
  it('rejects unknown keys at every environment record boundary', () => {
    const withUnknownKeys = JSON.parse(
      '{"name":"standards-sync","wait_timer":0,"prevent_self_review":false,"reviewers":[{"type":"User","id":1,"login":"ignored"}],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true,"protected_branch":false},"deployment_branch_policies":[{"name":"main","pattern":"main"}],"waitTimer":0}',
    );
    const loaded = loadGithubSettings(
      JSON.stringify({ environments: [withUnknownKeys] }),
      emptySeam,
    );

    expect(loaded.merged).toBeNull();
    expect(loaded.problems).toEqual([
      '.github/settings.json environments[0] has unknown key "deployment_branch_policies"',
      '.github/settings.json environments[0] has unknown key "waitTimer"',
      '.github/settings.json environments[0].reviewers[0] has unknown key "login"',
      '.github/settings.json environments[0].deployment_branch_policy has unknown key "protected_branch"',
      '.github/settings.json environments[0].deployment_branch_policy must enable protected branches only',
    ]);
  });

  it('rejects malformed environment protection and deployment policy data', () => {
    const malformed = JSON.parse(
      '{"name":"standards-sync","wait_timer":-1,"prevent_self_review":"no","reviewers":{},"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":true},"deployment_branch_policies":[{"name":""}]}',
    );
    const loaded = loadGithubSettings(
      JSON.stringify({ environments: [malformed] }),
      emptySeam,
    );
    expect(loaded.merged).toBeNull();
    expect(loaded.problems).toEqual([
      '.github/settings.json environments[0] has unknown key "deployment_branch_policies"',
      '.github/settings.json environments[0].wait_timer must be an integer from 0 to 43200',
      '.github/settings.json environments[0].prevent_self_review must be a boolean',
      '.github/settings.json environments[0].reviewers must be an array',
      '.github/settings.json environments[0].deployment_branch_policy must enable protected branches only',
    ]);
  });
});
