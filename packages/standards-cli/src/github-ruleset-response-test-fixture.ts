export const RULESET_REPOSITORY = 'owner/repo';

export const repositoryRulesetDetail = (
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({
  ...(JSON.parse(
    '{"_links":{"self":{"href":"https://api.github.test/rulesets/42"}},"bypass_actors":[],"conditions":{"ref_name":{"exclude":[],"include":["~DEFAULT_BRANCH"],"server_field":true}},"enforcement":"active","id":42,"name":"Protect main","rules":[{"server_rule_field":true,"type":"deletion"},{"type":"non_fast_forward"},{"type":"required_linear_history"},{"parameters":{"allowed_merge_methods":["squash","rebase"],"dismiss_stale_reviews_on_push":true,"require_code_owner_review":false,"require_last_push_approval":false,"required_approving_review_count":1,"required_review_thread_resolution":true,"required_reviewers":[],"server_default":true},"server_rule_field":true,"type":"pull_request"},{"parameters":{"do_not_enforce_on_create":false,"required_status_checks":[{"context":"check","integration_id":15368,"server_field":true}],"server_default":true,"strict_required_status_checks_policy":true},"type":"required_status_checks"}],"source":"owner/repo","source_type":"Repository","target":"branch"}',
  ) as Record<string, unknown>),
  ...overrides,
});
