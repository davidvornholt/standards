import { describe, expect, it } from 'bun:test';
import { loadGithubSettings } from './github-settings';

const canonical = JSON.stringify({
  repository: { allow_auto_merge: true },
  rulesets: [{ name: 'Protect main', target: 'branch' }],
});

const emptySeam = JSON.stringify({ repository: {}, rulesets: [] });

describe('loadGithubSettings', () => {
  it('merges an additive seam', () => {
    const local = JSON.stringify({
      repository: { has_wiki: false },
      rulesets: [{ name: 'Protect releases', target: 'branch' }],
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
  });

  it('requires the local seam to exist', () => {
    const loaded = loadGithubSettings(canonical, null);
    expect(loaded.merged).toBeNull();
    expect(loaded.problems).toEqual([
      '.github/settings.local.json must exist; seed it with {"repository":{},"rulesets":[]}',
    ]);
  });

  it('rejects overriding a canonical repository key and redefining a canonical ruleset together', () => {
    const local = JSON.stringify({
      repository: { allow_auto_merge: false },
      rulesets: [{ name: 'Protect main' }],
    });
    const loaded = loadGithubSettings(canonical, local);
    expect(loaded.merged).toBeNull();
    expect(loaded.problems).toEqual([
      '.github/settings.local.json repository."allow_auto_merge" would override a canonical value; canonical settings are read-only',
      '.github/settings.local.json ruleset "Protect main" collides with a canonical ruleset; add a separately named ruleset to tighten further',
    ]);
  });
});

describe('loadGithubSettings validation aggregation', () => {
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

  it('gathers merge problems when a file also has an unknown key', () => {
    const badCanonical = JSON.stringify({
      repository: { allow_auto_merge: true },
      rulesets: [],
      repositories: {},
    });
    const badLocal = JSON.stringify({
      repository: {},
      rulesets: [{ name: 'Protect releases' }],
      rulesetEnforcement: 'unavailable-on-plan',
    });
    const loaded = loadGithubSettings(badCanonical, badLocal);
    expect(loaded.merged).toBeNull();
    expect(loaded.problems).toEqual([
      '.github/settings.json has unknown key "repositories"',
      '.github/settings.local.json declares additional rulesets while "rulesetEnforcement" is "unavailable-on-plan"; remove the rulesets or the opt-out',
    ]);
  });

  it('gathers merge problems independent of malformed sibling fields', () => {
    const badCanonical = JSON.stringify({
      repository: { allow_auto_merge: true },
      rulesets: [{ name: 'Protect main' }, { target: 'branch' }],
    });
    const badLocal = JSON.stringify({
      repository: { allow_auto_merge: false },
      rulesets: [{ name: 'Protect main' }, null],
      rulesetEnforcement: 'unavailable-on-plan',
    });
    const loaded = loadGithubSettings(badCanonical, badLocal);
    expect(loaded.merged).toBeNull();
    expect(loaded.problems).toEqual([
      '.github/settings.json rulesets[1] must be an object with a non-empty "name"',
      '.github/settings.local.json rulesets[1] must be an object with a non-empty "name"',
      '.github/settings.local.json declares additional rulesets while "rulesetEnforcement" is "unavailable-on-plan"; remove the rulesets or the opt-out',
      '.github/settings.local.json repository."allow_auto_merge" would override a canonical value; canonical settings are read-only',
      '.github/settings.local.json ruleset "Protect main" collides with a canonical ruleset; add a separately named ruleset to tighten further',
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

  it('gathers local problems when canonical JSON is unavailable', () => {
    const badLocal = JSON.stringify({
      repository: {},
      rulesets: [{ target: 'branch' }],
      rulesetEnforcement: 'unavailable-on-plan',
    });
    const loaded = loadGithubSettings('{', badLocal);
    expect(loaded.merged).toBeNull();
    expect(loaded.problems).toEqual([
      '.github/settings.json must contain valid JSON',
      '.github/settings.local.json rulesets[0] must be an object with a non-empty "name"',
      '.github/settings.local.json declares additional rulesets while "rulesetEnforcement" is "unavailable-on-plan"; remove the rulesets or the opt-out',
    ]);
  });

  it('accepts the empty seam and defaults to enforced rulesets', () => {
    const loaded = loadGithubSettings(canonical, emptySeam);
    expect(loaded.problems).toEqual([]);
    expect(loaded.merged?.rulesets).toHaveLength(1);
    expect(loaded.merged?.rulesetEnforcement).toBe('enforced');
  });
});

describe('loadGithubSettings rulesetEnforcement', () => {
  it('accepts a declared ruleset-enforcement opt-out', () => {
    const local = JSON.stringify({
      repository: {},
      rulesets: [],
      rulesetEnforcement: 'unavailable-on-plan',
    });
    const loaded = loadGithubSettings(canonical, local);
    expect(loaded.problems).toEqual([]);
    expect(loaded.merged?.rulesetEnforcement).toBe('unavailable-on-plan');
    expect(loaded.merged?.rulesets).toHaveLength(1);
  });

  it('rejects any other rulesetEnforcement value, including an explicit "enforced"', () => {
    const local = JSON.stringify({
      repository: {},
      rulesets: [],
      rulesetEnforcement: 'enforced',
    });
    const loaded = loadGithubSettings(canonical, local);
    expect(loaded.merged).toBeNull();
    expect(loaded.problems).toEqual([
      '.github/settings.local.json "rulesetEnforcement" must be "unavailable-on-plan" when present; omit it on plans where GitHub enforces rulesets',
    ]);
  });

  it.each([
    ['the opt-out', 'unavailable-on-plan'],
    ['explicit enforcement', 'enforced'],
    ['null', null],
    ['true', true],
    ['false', false],
    ['a number', 1],
    ['an object', {}],
    ['an array', []],
  ])('rejects %s rulesetEnforcement in the canonical file', (_label, value) => {
    const badCanonical = JSON.stringify({
      repository: {},
      rulesets: [],
      rulesetEnforcement: value,
    });
    const loaded = loadGithubSettings(badCanonical, emptySeam);
    expect(loaded.merged).toBeNull();
    expect(loaded.problems).toEqual([
      '.github/settings.json has unknown key "rulesetEnforcement"',
    ]);
  });

  it('rejects local rulesets combined with the opt-out', () => {
    const local = JSON.stringify({
      repository: {},
      rulesets: [{ name: 'Protect releases' }],
      rulesetEnforcement: 'unavailable-on-plan',
    });
    const loaded = loadGithubSettings(canonical, local);
    expect(loaded.merged).toBeNull();
    expect(loaded.problems).toEqual([
      '.github/settings.local.json declares additional rulesets while "rulesetEnforcement" is "unavailable-on-plan"; remove the rulesets or the opt-out',
    ]);
  });
});
