import { describe, expect, it } from 'bun:test';
import { rulesetListProblems } from './github-ruleset-settings';

const supportedRuleset = JSON.parse(
  '{"name":"Protect main","target":"branch","enforcement":"active","conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},"bypass_actors":[],"rules":[{"type":"deletion"},{"type":"non_fast_forward"},{"type":"required_linear_history"},{"type":"pull_request","parameters":{"required_approving_review_count":0,"dismiss_stale_reviews_on_push":true,"required_reviewers":[],"require_code_owner_review":false,"require_last_push_approval":false,"required_review_thread_resolution":true,"allowed_merge_methods":["squash","rebase"]}},{"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":true,"do_not_enforce_on_create":false,"required_status_checks":[{"context":"check","integration_id":15368}]}}]}',
) as Readonly<Record<string, unknown>>;
const REF_NAME = 'ref_name';

const problemsForRules = (rules: unknown): ReadonlyArray<string> =>
  rulesetListProblems(
    [{ ...supportedRuleset, rules }],
    '.github/settings.json',
  );

describe('ruleset declaration validation', () => {
  it('accepts every supported rule and parameter shape', () => {
    expect(
      rulesetListProblems([supportedRuleset], '.github/settings.json'),
    ).toEqual([]);
  });

  it('accepts immutable tag rules without restricting creation', () => {
    const tagRuleset = {
      ...supportedRuleset,
      conditions: {
        [REF_NAME]: { exclude: [], include: ['refs/tags/v*'] },
      },
      rules: [{ type: 'update' }, { type: 'deletion' }],
      target: 'tag',
    };
    expect(rulesetListProblems([tagRuleset], '.github/settings.json')).toEqual(
      [],
    );
  });

  it('rejects parameters on parameterless rules and unsupported rule types', () => {
    expect(
      problemsForRules([
        { parameters: {}, type: 'deletion' },
        { type: 'creation' },
      ]),
    ).toEqual([
      '.github/settings.json rulesets[0].rules[0] has unknown key "parameters"',
      '.github/settings.json rulesets[0].rules[1].type "creation" is not supported for branch rulesets',
    ]);
  });

  it('rejects rules that do not apply to the declared target', () => {
    expect(problemsForRules([{ type: 'update' }])).toEqual([
      '.github/settings.json rulesets[0].rules[0].type "update" is not supported for branch rulesets',
    ]);
    expect(
      rulesetListProblems(
        [
          {
            ...supportedRuleset,
            rules: [{ type: 'pull_request', parameters: {} }],
            target: 'tag',
          },
        ],
        '.github/settings.json',
      ),
    ).toEqual([
      '.github/settings.json rulesets[0].rules[0].type "pull_request" is not supported for tag rulesets',
    ]);
  });

  it('rejects malformed and duplicate required status checks', () => {
    const malformed = JSON.parse(
      '{"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":true,"do_not_enforce_on_create":false,"required_status_checks":[{"context":"check","integration_id":15368},{"context":"check","integration_id":15368}]}}',
    ) as unknown;
    expect(problemsForRules([malformed])).toContain(
      '.github/settings.json rulesets[0].rules[0].parameters.required_status_checks must not contain duplicates',
    );
  });

  it('bounds required approving reviews to the GitHub ruleset limit', () => {
    const excessive = JSON.parse(
      '{"type":"pull_request","parameters":{"required_approving_review_count":11,"dismiss_stale_reviews_on_push":true,"required_reviewers":[],"require_code_owner_review":false,"require_last_push_approval":false,"required_review_thread_resolution":true,"allowed_merge_methods":["squash"]}}',
    ) as unknown;
    expect(problemsForRules([excessive])).toContain(
      '.github/settings.json rulesets[0].rules[0].parameters.required_approving_review_count must be an integer from 0 to 10',
    );
  });
});
