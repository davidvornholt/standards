import { afterEach, describe, expect, it } from 'bun:test';
import { applyRulesets } from './github-apply';
import { diffRuleset } from './github-diff';
import { decodeRepositoryRulesetDetail } from './github-ruleset-response';
import {
  RULESET_REPOSITORY,
  repositoryRulesetDetail,
} from './github-ruleset-response-test-fixture';
import { fetchLiveRulesets } from './github-rulesets';
import type { GithubSettings } from './github-settings-value';

const originalFetch = globalThis.fetch;
const ACTOR_ID = 'actor_id';
const ACTOR_TYPE = 'actor_type';
const BYPASS_ACTORS = 'bypass_actors';
const BYPASS_MODE = 'bypass_mode';
const DO_NOT_ENFORCE = 'do_not_enforce_on_create';
const INTEGRATION_ID = 'integration_id';
const REQUIRED_STATUS_CHECKS = 'required_status_checks';
const SOURCE_TYPE = 'source_type';
const STRICT_STATUS_CHECKS = 'strict_required_status_checks_policy';
const NON_INTEGER_ID = 1.5;

const declared = JSON.parse(
  '{"defaultBranchProtection":null,"environments":[],"repository":{},"rulesets":[{"bypass_actors":[],"conditions":{"ref_name":{"exclude":[],"include":["~DEFAULT_BRANCH"]}},"enforcement":"active","name":"Protect main","rules":[{"type":"deletion"}],"target":"branch"}]}',
) as GithubSettings;
const declaredStatusRuleset = JSON.parse(
  '{"bypass_actors":[],"conditions":{"ref_name":{"exclude":[],"include":["~DEFAULT_BRANCH"]}},"enforcement":"active","name":"Protect main","rules":[{"parameters":{"do_not_enforce_on_create":false,"required_status_checks":[{"context":"check","integration_id":15368}],"strict_required_status_checks_policy":true},"type":"required_status_checks"}],"target":"branch"}',
) as Readonly<Record<string, unknown>>;

const statusRule = (integrationId?: unknown) => ({
  parameters: {
    [DO_NOT_ENFORCE]: false,
    [REQUIRED_STATUS_CHECKS]: [
      integrationId === undefined
        ? { context: 'check' }
        : { context: 'check', [INTEGRATION_ID]: integrationId },
    ],
    [STRICT_STATUS_CHECKS]: true,
  },
  type: 'required_status_checks',
});

const actor = (type: string, id: unknown, mode: string) => ({
  [ACTOR_ID]: id,
  [ACTOR_TYPE]: type,
  [BYPASS_MODE]: mode,
});

const mockRulesetReads = (body: Readonly<Record<string, unknown>>) => {
  const methods: Array<string> = [];
  globalThis.fetch = Object.assign(
    (input: URL | RequestInfo, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      const responseBody = String(input).includes('rulesets?')
        ? [
            {
              id: 42,
              name: 'Protect main',
              source: RULESET_REPOSITORY,
              [SOURCE_TYPE]: 'Repository',
            },
          ]
        : body;
      return Promise.resolve(
        new Response(JSON.stringify(responseBody), { status: 200 }),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  return methods;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ruleset response visibility', () => {
  it('keeps hidden bypass actors unverifiable during check', async () => {
    const hiddenBypass = Object.fromEntries(
      Object.entries(
        repositoryRulesetDetail({ rules: [{ type: 'deletion' }] }),
      ).filter(([key]) => key !== BYPASS_ACTORS),
    );
    const methods = mockRulesetReads(hiddenBypass);
    const live = await fetchLiveRulesets('token', RULESET_REPOSITORY, false);
    expect(live.problem).toBeNull();
    expect(
      diffRuleset(declared.rulesets[0] ?? {}, live.rulesets?.[0] ?? {}),
    ).toEqual({
      drifted: [],
      unverifiable: ['ruleset "Protect main": bypass_actors'],
    });
    expect(methods).toEqual(['GET', 'GET']);
  });

  it('makes no write when apply cannot see bypass actors', async () => {
    const hiddenBypass = Object.fromEntries(
      Object.entries(
        repositoryRulesetDetail({ rules: [{ type: 'deletion' }] }),
      ).filter(([key]) => key !== BYPASS_ACTORS),
    );
    const methods = mockRulesetReads(hiddenBypass);
    await expect(
      applyRulesets('token', RULESET_REPOSITORY, declared),
    ).rejects.toThrow('invalid detailed repository ruleset state');
    expect(methods).toEqual(['GET', 'GET']);
  });
});

describe('ruleset response status checks', () => {
  it('accepts an omitted integration ID as repairable drift', () => {
    const live = repositoryRulesetDetail({ rules: [statusRule()] });
    expect(
      decodeRepositoryRulesetDetail(live, RULESET_REPOSITORY, false).value,
    ).toBe(live);
    expect(diffRuleset(declaredStatusRuleset, live)).toEqual({
      drifted: [
        'ruleset "Protect main": rule "required_status_checks" differs from the declared configuration',
      ],
      unverifiable: [],
    });
  });

  it.each([
    null,
    0,
    -1,
    NON_INTEGER_ID,
    '15368',
  ])('rejects malformed present integration ID %p', (integrationId) => {
    const live = repositoryRulesetDetail({
      rules: [statusRule(integrationId)],
    });
    expect(
      decodeRepositoryRulesetDetail(live, RULESET_REPOSITORY, false).value,
    ).toBeNull();
  });
});

describe('ruleset response bypass actors', () => {
  it.each([
    [actor('DeployKey', null, 'always'), 'branch'],
    [actor('OrganizationAdmin', null, 'exempt'), 'tag'],
    [actor('Team', 1, 'pull_request'), 'branch'],
    [actor('User', 2, 'always'), 'push'],
  ] as const)('accepts contextual actor %#', (bypassActor, target) => {
    const live = repositoryRulesetDetail({
      [BYPASS_ACTORS]: [bypassActor],
      target,
    });
    expect(
      decodeRepositoryRulesetDetail(live, RULESET_REPOSITORY, false).value,
    ).toBe(live);
  });

  it.each([
    [actor('DeployKey', null, 'pull_request'), 'branch'],
    [actor('Team', 1, 'pull_request'), 'tag'],
    [actor('Team', 1, 'pull_request'), 'push'],
    [actor('DeployKey', 1, 'always'), 'branch'],
    [actor('User', null, 'always'), 'branch'],
  ] as const)('rejects contextual actor %#', (bypassActor, target) => {
    const live = repositoryRulesetDetail({
      [BYPASS_ACTORS]: [bypassActor],
      target,
    });
    expect(
      decodeRepositoryRulesetDetail(live, RULESET_REPOSITORY, false).value,
    ).toBeNull();
  });
});
