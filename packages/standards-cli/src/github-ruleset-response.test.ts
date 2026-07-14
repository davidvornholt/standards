import { afterEach, describe, expect, it } from 'bun:test';
import { applyRulesets } from './github-apply';
import { decodeRepositoryRulesetDetail } from './github-ruleset-response';
import {
  RULESET_REPOSITORY,
  repositoryRulesetDetail,
} from './github-ruleset-response-test-fixture';
import type { GithubSettings } from './github-settings';

const originalFetch = globalThis.fetch;
const ACTOR_ID = 'actor_id';
const ACTOR_TYPE = 'actor_type';
const BYPASS_ACTORS = 'bypass_actors';
const BYPASS_MODE = 'bypass_mode';
const DO_NOT_ENFORCE = 'do_not_enforce_on_create';
const INTEGRATION_ID = 'integration_id';
const REF_NAME = 'ref_name';
const REQUIRED_STATUS_CHECKS = 'required_status_checks';
const SOURCE_TYPE = 'source_type';
const STRICT_STATUS_CHECKS = 'strict_required_status_checks_policy';

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('detailed repository ruleset response', () => {
  it('accepts every managed shape while preserving ignored server fields', () => {
    const body = repositoryRulesetDetail();
    expect(
      decodeRepositoryRulesetDetail(body, RULESET_REPOSITORY, false),
    ).toEqual({
      problem: null,
      value: body,
    });
    const hiddenBypass = Object.fromEntries(
      Object.entries(body).filter(([key]) => key !== 'bypass_actors'),
    );
    expect(
      decodeRepositoryRulesetDetail(hiddenBypass, RULESET_REPOSITORY, false)
        .value,
    ).toBe(hiddenBypass);
  });

  it.each([
    ['non-record rule', { rules: ['malformed'] }],
    ['missing rules', { rules: undefined }],
    ['empty rules', { rules: [] }],
    ['unsupported rule', { rules: [{ type: 'creation' }] }],
    [
      'duplicate rule types',
      { rules: [{ type: 'deletion' }, { type: 'deletion' }] },
    ],
    [
      'parameters on a parameterless rule',
      { rules: [{ parameters: {}, type: 'deletion' }] },
    ],
    [
      'malformed pull-request parameters',
      { rules: [{ type: 'pull_request' }] },
    ],
    [
      'malformed status-check parameters',
      {
        rules: [
          {
            parameters: {
              [DO_NOT_ENFORCE]: false,
              [REQUIRED_STATUS_CHECKS]: [
                { context: 'check', [INTEGRATION_ID]: '15368' },
              ],
              [STRICT_STATUS_CHECKS]: true,
            },
            type: 'required_status_checks',
          },
        ],
      },
    ],
    ['invalid target', { target: 'repository' }],
    ['invalid enforcement', { enforcement: 'enabled' }],
    [
      'malformed conditions',
      { conditions: { [REF_NAME]: { exclude: [], include: [null] } } },
    ],
    ['malformed bypass collection', { [BYPASS_ACTORS]: {} }],
    [
      'malformed bypass actor',
      {
        [BYPASS_ACTORS]: [
          { [ACTOR_ID]: 1, [ACTOR_TYPE]: 'Team', [BYPASS_MODE]: 'sometimes' },
        ],
      },
    ],
    [
      'duplicate bypass actors',
      {
        [BYPASS_ACTORS]: [
          { [ACTOR_ID]: 1, [ACTOR_TYPE]: 'Team', [BYPASS_MODE]: 'always' },
          {
            [ACTOR_ID]: 1,
            [ACTOR_TYPE]: 'Team',
            [BYPASS_MODE]: 'pull_request',
          },
        ],
      },
    ],
  ] as const)('rejects %s', (_label, override) => {
    expect(
      decodeRepositoryRulesetDetail(
        repositoryRulesetDetail(override),
        RULESET_REPOSITORY,
        false,
      ),
    ).toEqual({
      problem: 'GitHub returned an invalid detailed repository ruleset state',
      value: null,
    });
  });
});

describe('malformed ruleset apply boundary', () => {
  it('makes no write when a detailed rules collection is malformed', async () => {
    const methods: Array<string> = [];
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        methods.push(method);
        return Promise.resolve(
          new Response(
            JSON.stringify(
              String(input).includes('rulesets?')
                ? [
                    {
                      id: 42,
                      name: 'Protect main',
                      source: RULESET_REPOSITORY,
                      [SOURCE_TYPE]: 'Repository',
                    },
                  ]
                : repositoryRulesetDetail({ rules: ['malformed'] }),
            ),
            { status: 200 },
          ),
        );
      },
      { preconnect: originalFetch.preconnect },
    );
    const declared = JSON.parse(
      '{"defaultBranchProtection":null,"environments":[],"repository":{},"rulesets":[{"bypass_actors":[],"conditions":{"ref_name":{"exclude":[],"include":["~DEFAULT_BRANCH"]}},"enforcement":"active","name":"Protect main","rules":[{"type":"deletion"}],"target":"branch"}]}',
    ) as GithubSettings;

    await expect(
      applyRulesets('token', RULESET_REPOSITORY, declared),
    ).rejects.toThrow('invalid detailed repository ruleset state');
    expect(methods).toEqual(['GET', 'GET']);
  });
});
