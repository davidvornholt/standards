import { rulesetListProblems } from './github-ruleset-settings';
import { isPositiveSafeInteger, isRecord } from './github-settings-value';

type DecodeResult = {
  readonly problem: string | null;
  readonly value: Record<string, unknown> | null;
};

const TARGETS = new Set(['branch', 'push', 'tag']);
const ENFORCEMENTS = new Set(['active', 'disabled', 'evaluate']);
const BYPASS_ACTOR_TYPES = new Set(
  'DeployKey Integration OrganizationAdmin RepositoryRole Team User'.split(' '),
);
const BYPASS_MODES = new Set(['always', 'exempt', 'pull_request']);
const PARAMETERLESS_RULES = new Set([
  'deletion',
  'non_fast_forward',
  'required_linear_history',
]);
const REF_NAME = 'ref_name';
const BYPASS_ACTORS = 'bypass_actors';
const INTEGRATION_ID = 'integration_id';
const REQUIRED_STATUS_CHECKS = 'required_status_checks';
const PULL_REQUEST_PARAMETER_KEYS = [
  'allowed_merge_methods',
  'dismiss_stale_reviews_on_push',
  'require_code_owner_review',
  'require_last_push_approval',
  'required_approving_review_count',
  'required_review_thread_resolution',
  'required_reviewers',
] as const;
const STATUS_PARAMETER_KEYS = [
  'do_not_enforce_on_create',
  REQUIRED_STATUS_CHECKS,
  'strict_required_status_checks_policy',
] as const;

const invalid = (detail: string): DecodeResult => ({
  problem: `GitHub returned ${detail}`,
  value: null,
});

const bypassActorIdIsValid = (type: string, id: unknown): boolean => {
  if (type === 'DeployKey') {
    return id === null;
  }
  return type === 'OrganizationAdmin'
    ? id === null || isPositiveSafeInteger(id)
    : isPositiveSafeInteger(id);
};

export const isRepositoryRulesetIdentity = (
  value: unknown,
  repo: string,
): value is Record<string, unknown> =>
  isRecord(value) &&
  isPositiveSafeInteger(value.id) &&
  typeof value.name === 'string' &&
  value.name.length > 0 &&
  value.source_type === 'Repository' &&
  typeof value.source === 'string' &&
  value.source.toLowerCase() === repo.toLowerCase();

const bypassActorsAreValid = (value: unknown, target: unknown): boolean => {
  if (value === undefined) {
    return true;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  const identities = new Set<string>();
  return value.every((actor) => {
    if (
      !isRecord(actor) ||
      typeof actor.actor_type !== 'string' ||
      !BYPASS_ACTOR_TYPES.has(actor.actor_type) ||
      typeof actor.bypass_mode !== 'string' ||
      !BYPASS_MODES.has(actor.bypass_mode) ||
      (actor.bypass_mode === 'pull_request' &&
        (target !== 'branch' || actor.actor_type === 'DeployKey'))
    ) {
      return false;
    }
    const identity = `${actor.actor_type}\u0000${String(actor.actor_id)}`;
    if (
      !bypassActorIdIsValid(actor.actor_type, actor.actor_id) ||
      identities.has(identity)
    ) {
      return false;
    }
    identities.add(identity);
    return true;
  });
};

const managedConditions = (value: unknown): unknown => {
  if (!(isRecord(value) && isRecord(value.ref_name))) {
    return value;
  }
  return {
    [REF_NAME]: {
      exclude: value.ref_name.exclude,
      include: value.ref_name.include,
    },
  };
};

const managedFields = (
  value: Readonly<Record<string, unknown>>,
  keys: ReadonlyArray<string>,
) => Object.fromEntries(keys.map((key) => [key, value[key]]));

const managedStatusChecks = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map((check) =>
        isRecord(check)
          ? { context: check.context, [INTEGRATION_ID]: check.integration_id }
          : check,
      )
    : value;

const managedParameters = (type: unknown, value: unknown): unknown => {
  if (!isRecord(value)) {
    return value;
  }
  if (type === 'pull_request') {
    return managedFields(value, PULL_REQUEST_PARAMETER_KEYS);
  }
  if (type === 'required_status_checks') {
    return {
      ...managedFields(value, STATUS_PARAMETER_KEYS),
      [REQUIRED_STATUS_CHECKS]: managedStatusChecks(
        value.required_status_checks,
      ),
    };
  }
  return value;
};

const managedRules = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map((rule) => {
        if (!isRecord(rule)) {
          return rule;
        }
        if (
          typeof rule.type === 'string' &&
          PARAMETERLESS_RULES.has(rule.type)
        ) {
          return Object.hasOwn(rule, 'parameters')
            ? { parameters: rule.parameters, type: rule.type }
            : { type: rule.type };
        }
        return {
          parameters: managedParameters(rule.type, rule.parameters),
          type: rule.type,
        };
      })
    : value;

export const decodeRepositoryRulesetDetail = (
  body: unknown,
  repo: string,
  detailRequired: boolean,
): DecodeResult => {
  if (!isRepositoryRulesetIdentity(body, repo)) {
    return invalid('an invalid detailed repository ruleset identity');
  }
  if (
    typeof body.target !== 'string' ||
    !TARGETS.has(body.target) ||
    typeof body.enforcement !== 'string' ||
    !ENFORCEMENTS.has(body.enforcement) ||
    (detailRequired && body.bypass_actors === undefined) ||
    !bypassActorsAreValid(body.bypass_actors, body.target)
  ) {
    return invalid('an invalid detailed repository ruleset state');
  }
  const problems = rulesetListProblems(
    [
      {
        [BYPASS_ACTORS]: [],
        conditions: managedConditions(body.conditions),
        enforcement: 'active',
        name: body.name,
        rules: managedRules(body.rules),
        target: 'branch',
      },
    ],
    'GitHub live state',
    false,
  );
  return problems.length === 0
    ? { problem: null, value: body }
    : invalid('an invalid detailed repository ruleset state');
};
