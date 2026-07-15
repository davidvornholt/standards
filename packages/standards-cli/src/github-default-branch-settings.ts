import { isRecord } from './github-settings-value';

const BOOLEAN_KEYS = [
  'enforce_admins',
  'required_linear_history',
  'allow_force_pushes',
  'allow_deletions',
  'block_creations',
  'required_conversation_resolution',
  'required_signatures',
  'lock_branch',
  'allow_fork_syncing',
] as const;
const TOP_LEVEL_KEYS = new Set([
  ...BOOLEAN_KEYS,
  'required_status_checks',
  'required_pull_request_reviews',
  'restrictions',
]);
const STATUS_KEYS = new Set(['strict', 'checks']);
const REVIEW_KEYS = new Set([
  'dismiss_stale_reviews',
  'require_code_owner_reviews',
  'required_approving_review_count',
  'require_last_push_approval',
  'bypass_pull_request_allowances',
]);
const ACTOR_KEYS = new Set(['users', 'teams', 'apps']);
const MAX_APPROVING_REVIEWS = 6;

const unknownKeys = (
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  prefix: string,
): ReadonlyArray<string> =>
  Object.keys(value).flatMap((key) =>
    allowed.has(key) ? [] : [`${prefix} has unknown key "${key}"`],
  );

const stringArrayProblems = (value: unknown, prefix: string) =>
  !Array.isArray(value) || value.some((entry) => typeof entry !== 'string')
    ? [`${prefix} must be an array of strings`]
    : [];

const actorProblems = (value: unknown, prefix: string) => {
  if (!isRecord(value)) {
    return [`${prefix} must be an actor collection`];
  }
  return [
    ...unknownKeys(value, ACTOR_KEYS, prefix),
    ...stringArrayProblems(value.users, `${prefix}.users`),
    ...stringArrayProblems(value.teams, `${prefix}.teams`),
    ...stringArrayProblems(value.apps, `${prefix}.apps`),
  ];
};

const statusProblems = (value: unknown, prefix: string) => {
  if (!isRecord(value)) {
    return [`${prefix} must be an object`];
  }
  const checksAreValid =
    Array.isArray(value.checks) &&
    value.checks.every(
      (check) =>
        isRecord(check) &&
        Object.keys(check).every(
          (key) => key === 'context' || key === 'app_id',
        ) &&
        typeof check.context === 'string' &&
        check.context.length > 0 &&
        Number.isSafeInteger(check.app_id) &&
        Number(check.app_id) > 0,
    );
  const checkIdentities = Array.isArray(value.checks)
    ? value.checks.flatMap((check) =>
        isRecord(check) &&
        typeof check.context === 'string' &&
        Number.isSafeInteger(check.app_id)
          ? [`${check.context}\u0000${String(check.app_id)}`]
          : [],
      )
    : [];
  return [
    ...unknownKeys(value, STATUS_KEYS, prefix),
    ...(typeof value.strict === 'boolean'
      ? []
      : [`${prefix}.strict must be a boolean`]),
    ...(checksAreValid
      ? []
      : [`${prefix}.checks must contain context and positive app_id pairs`]),
    ...(new Set(checkIdentities).size === checkIdentities.length
      ? []
      : [
          `${prefix}.checks must not contain duplicate context and app_id pairs`,
        ]),
  ];
};

const reviewProblems = (value: unknown, prefix: string) => {
  if (!isRecord(value)) {
    return [`${prefix} must be an object`];
  }
  const problems = [...unknownKeys(value, REVIEW_KEYS, prefix)];
  for (const key of [
    'dismiss_stale_reviews',
    'require_code_owner_reviews',
    'require_last_push_approval',
  ] as const) {
    if (typeof value[key] !== 'boolean') {
      problems.push(`${prefix}.${key} must be a boolean`);
    }
  }
  if (
    !Number.isSafeInteger(value.required_approving_review_count) ||
    Number(value.required_approving_review_count) < 0 ||
    Number(value.required_approving_review_count) > MAX_APPROVING_REVIEWS
  ) {
    problems.push(
      `${prefix}.required_approving_review_count must be an integer from 0 to ${MAX_APPROVING_REVIEWS}`,
    );
  }
  problems.push(
    ...actorProblems(
      value.bypass_pull_request_allowances,
      `${prefix}.bypass_pull_request_allowances`,
    ),
  );
  return problems;
};

export const defaultBranchProtectionProblems = (
  value: unknown,
  label: string,
): ReadonlyArray<string> => {
  if (!isRecord(value)) {
    return [`${label} must be an object`];
  }
  const problems = [...unknownKeys(value, TOP_LEVEL_KEYS, label)];
  for (const key of BOOLEAN_KEYS) {
    if (typeof value[key] !== 'boolean') {
      problems.push(`${label}.${key} must be a boolean`);
    }
  }
  if (value.required_signatures === true) {
    problems.push(
      `${label}.required_signatures must be false; enabling required signatures is outside the canonical policy`,
    );
  }
  problems.push(
    ...statusProblems(
      value.required_status_checks,
      `${label}.required_status_checks`,
    ),
    ...reviewProblems(
      value.required_pull_request_reviews,
      `${label}.required_pull_request_reviews`,
    ),
  );
  if (value.restrictions !== null) {
    problems.push(`${label}.restrictions must be null`);
  }
  return problems;
};
