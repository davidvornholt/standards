const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const RULE_KEYS = new Set(['type', 'parameters']);
const PULL_REQUEST_PARAMETER_KEYS = new Set([
  'required_approving_review_count',
  'dismiss_stale_reviews_on_push',
  'required_reviewers',
  'require_code_owner_review',
  'require_last_push_approval',
  'required_review_thread_resolution',
  'allowed_merge_methods',
]);
const STATUS_PARAMETER_KEYS = new Set([
  'strict_required_status_checks_policy',
  'do_not_enforce_on_create',
  'required_status_checks',
]);
const STATUS_CHECK_KEYS = new Set(['context', 'integration_id']);
const MAX_APPROVING_REVIEWS = 10;
const PARAMETERLESS_RULES = new Set([
  'deletion',
  'non_fast_forward',
  'required_linear_history',
]);
const MERGE_METHODS = new Set(['merge', 'squash', 'rebase']);

const unknownKeyProblems = (
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  prefix: string,
): ReadonlyArray<string> =>
  Object.keys(value).flatMap((key) =>
    allowed.has(key) ? [] : [`${prefix} has unknown key "${key}"`],
  );

const pullRequestParameterProblems = (
  value: unknown,
  prefix: string,
): ReadonlyArray<string> => {
  if (!isRecord(value)) {
    return [`${prefix} must be an object`];
  }
  const problems = [
    ...unknownKeyProblems(value, PULL_REQUEST_PARAMETER_KEYS, prefix),
  ];
  if (
    !Number.isSafeInteger(value.required_approving_review_count) ||
    Number(value.required_approving_review_count) < 0 ||
    Number(value.required_approving_review_count) > MAX_APPROVING_REVIEWS
  ) {
    problems.push(
      `${prefix}.required_approving_review_count must be an integer from 0 to ${MAX_APPROVING_REVIEWS}`,
    );
  }
  for (const key of [
    'dismiss_stale_reviews_on_push',
    'require_code_owner_review',
    'require_last_push_approval',
    'required_review_thread_resolution',
  ] as const) {
    if (typeof value[key] !== 'boolean') {
      problems.push(`${prefix}.${key} must be a boolean`);
    }
  }
  if (
    !Array.isArray(value.required_reviewers) ||
    value.required_reviewers.length > 0
  ) {
    problems.push(`${prefix}.required_reviewers must be an empty array`);
  }
  const methods = value.allowed_merge_methods;
  if (
    !Array.isArray(methods) ||
    methods.length === 0 ||
    methods.some(
      (method) => typeof method !== 'string' || !MERGE_METHODS.has(method),
    ) ||
    new Set(methods).size !== methods.length
  ) {
    problems.push(
      `${prefix}.allowed_merge_methods must contain unique supported merge methods`,
    );
  }
  return problems;
};

const statusParameterProblems = (
  value: unknown,
  prefix: string,
  integrationIdRequired: boolean,
): ReadonlyArray<string> => {
  if (!isRecord(value)) {
    return [`${prefix} must be an object`];
  }
  const checks = value.required_status_checks;
  const validChecks =
    Array.isArray(checks) &&
    checks.length > 0 &&
    checks.every(
      (check) =>
        isRecord(check) &&
        unknownKeyProblems(check, STATUS_CHECK_KEYS, prefix).length === 0 &&
        typeof check.context === 'string' &&
        check.context.length > 0 &&
        (check.integration_id === undefined
          ? !integrationIdRequired
          : Number.isSafeInteger(check.integration_id) &&
            Number(check.integration_id) > 0),
    );
  const identities = Array.isArray(checks)
    ? checks.flatMap((check) =>
        isRecord(check) &&
        typeof check.context === 'string' &&
        (check.integration_id === undefined ||
          Number.isSafeInteger(check.integration_id))
          ? [`${check.context}\u0000${String(check.integration_id)}`]
          : [],
      )
    : [];
  return [
    ...unknownKeyProblems(value, STATUS_PARAMETER_KEYS, prefix),
    ...(typeof value.strict_required_status_checks_policy === 'boolean'
      ? []
      : [`${prefix}.strict_required_status_checks_policy must be a boolean`]),
    ...(typeof value.do_not_enforce_on_create === 'boolean'
      ? []
      : [`${prefix}.do_not_enforce_on_create must be a boolean`]),
    ...(validChecks
      ? []
      : [`${prefix}.required_status_checks must contain valid status checks`]),
    ...(identities.length === new Set(identities).size
      ? []
      : [`${prefix}.required_status_checks must not contain duplicates`]),
  ];
};

const ruleProblems = (
  value: unknown,
  prefix: string,
  integrationIdRequired: boolean,
): ReadonlyArray<string> => {
  if (
    !isRecord(value) ||
    typeof value.type !== 'string' ||
    value.type.length === 0
  ) {
    return [`${prefix} must be an object with a non-empty "type"`];
  }
  if (PARAMETERLESS_RULES.has(value.type)) {
    return unknownKeyProblems(value, new Set(['type']), prefix);
  }
  if (value.type === 'pull_request') {
    return [
      ...unknownKeyProblems(value, RULE_KEYS, prefix),
      ...pullRequestParameterProblems(value.parameters, `${prefix}.parameters`),
    ];
  }
  if (value.type === 'required_status_checks') {
    return [
      ...unknownKeyProblems(value, RULE_KEYS, prefix),
      ...statusParameterProblems(
        value.parameters,
        `${prefix}.parameters`,
        integrationIdRequired,
      ),
    ];
  }
  return [`${prefix}.type "${value.type}" is not supported`];
};

export const rulesProblems = (
  value: unknown,
  prefix: string,
  integrationIdRequired = true,
): ReadonlyArray<string> => {
  if (!Array.isArray(value) || value.length === 0) {
    return [`${prefix} must be a non-empty array`];
  }
  const types = value.flatMap((rule) =>
    isRecord(rule) && typeof rule.type === 'string' ? [rule.type] : [],
  );
  return [
    ...value.flatMap((rule, index) =>
      ruleProblems(rule, `${prefix}[${index}]`, integrationIdRequired),
    ),
    ...(types.length === new Set(types).size
      ? []
      : [`${prefix} must not contain duplicate rule types`]),
  ];
};
