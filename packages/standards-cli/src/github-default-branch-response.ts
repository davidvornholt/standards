import { isRecord } from './github-settings';

const APP_ID = 'app_id';
const BYPASS_ALLOWANCES = 'bypass_pull_request_allowances';
const DISMISS_STALE = 'dismiss_stale_reviews';
const CODE_OWNER_REVIEWS = 'require_code_owner_reviews';
const LAST_PUSH_APPROVAL = 'require_last_push_approval';
const APPROVING_REVIEW_COUNT = 'required_approving_review_count';
const REQUIRED_REVIEWS = 'required_pull_request_reviews';
const REQUIRED_CHECKS = 'required_status_checks';

type DecodeResult<T> = {
  readonly problem: string | null;
  readonly value: T | null;
};

const invalid = <T>(detail: string): DecodeResult<T> => ({
  problem: `GitHub returned ${detail}`,
  value: null,
});

export const decodeDefaultBranch = (body: unknown): DecodeResult<string> =>
  isRecord(body) &&
  typeof body.default_branch === 'string' &&
  body.default_branch.length > 0
    ? { problem: null, value: body.default_branch }
    : invalid('an invalid repository default branch');

export const decodeBranchSummary = (
  body: unknown,
  branch: string,
): DecodeResult<boolean> => {
  const protection = isRecord(body) ? body.protection : null;
  return isRecord(body) &&
    body.name === branch &&
    typeof body.protected === 'boolean' &&
    isRecord(protection) &&
    typeof protection.enabled === 'boolean'
    ? { problem: null, value: body.protected && protection.enabled }
    : invalid(`an invalid branch summary for "${branch}"`);
};

const actorCollection = (
  value: unknown,
): Readonly<
  Record<'apps' | 'teams' | 'users', ReadonlyArray<string>>
> | null => {
  if (!isRecord(value)) {
    return null;
  }
  const identities = (
    entries: unknown,
    key: 'login' | 'slug',
  ): ReadonlyArray<string> | null =>
    Array.isArray(entries) &&
    entries.every((entry) => isRecord(entry) && typeof entry[key] === 'string')
      ? entries.map((entry) => String(entry[key]))
      : null;
  const users = identities(value.users ?? [], 'login');
  const teams = identities(value.teams ?? [], 'slug');
  const apps = identities(value.apps ?? [], 'slug');
  return users === null || teams === null || apps === null
    ? null
    : { apps, teams, users };
};

const enabled = (body: Readonly<Record<string, unknown>>, key: string) => {
  const wrapper = body[key];
  if (wrapper === undefined) {
    return false;
  }
  return isRecord(wrapper) && typeof wrapper.enabled === 'boolean'
    ? wrapper.enabled
    : null;
};

const decodeChecks = (value: unknown) => {
  if (
    !isRecord(value) ||
    typeof value.strict !== 'boolean' ||
    !Array.isArray(value.checks)
  ) {
    return null;
  }
  const checks: Array<Readonly<Record<string, unknown>>> = [];
  for (const check of value.checks) {
    if (
      !isRecord(check) ||
      typeof check.context !== 'string' ||
      !(check.app_id === null || Number.isSafeInteger(check.app_id))
    ) {
      return null;
    }
    checks.push({ [APP_ID]: check.app_id, context: check.context });
  }
  return { checks, strict: value.strict };
};

const decodeReviews = (value: unknown) => {
  if (
    !isRecord(value) ||
    typeof value.dismiss_stale_reviews !== 'boolean' ||
    typeof value.require_code_owner_reviews !== 'boolean' ||
    !(
      value.require_last_push_approval === undefined ||
      typeof value.require_last_push_approval === 'boolean'
    ) ||
    !(
      value.required_approving_review_count === undefined ||
      Number.isSafeInteger(value.required_approving_review_count)
    )
  ) {
    return null;
  }
  const bypass = actorCollection(value.bypass_pull_request_allowances ?? {});
  if (bypass === null) {
    return null;
  }
  return {
    [BYPASS_ALLOWANCES]: bypass,
    [DISMISS_STALE]: value.dismiss_stale_reviews,
    [CODE_OWNER_REVIEWS]: value.require_code_owner_reviews,
    [LAST_PUSH_APPROVAL]: value.require_last_push_approval ?? false,
    [APPROVING_REVIEW_COUNT]: value.required_approving_review_count ?? 0,
  };
};

export const decodeDefaultBranchProtection = (
  body: unknown,
): DecodeResult<Readonly<Record<string, unknown>>> => {
  if (!isRecord(body)) {
    return invalid('an invalid default-branch protection response');
  }
  const statusValue = body.required_status_checks;
  const status =
    statusValue === undefined || statusValue === null
      ? null
      : decodeChecks(statusValue);
  const reviewsValue = body.required_pull_request_reviews;
  const reviews =
    reviewsValue === undefined || reviewsValue === null
      ? null
      : decodeReviews(reviewsValue);
  const restrictions =
    body.restrictions === undefined || body.restrictions === null
      ? null
      : actorCollection(body.restrictions);
  const booleans = Object.fromEntries(
    [
      'enforce_admins',
      'required_linear_history',
      'allow_force_pushes',
      'allow_deletions',
      'block_creations',
      'required_conversation_resolution',
      'required_signatures',
      'lock_branch',
      'allow_fork_syncing',
    ].map((key) => [key, enabled(body, key)]),
  );
  if (
    (status === null && statusValue !== undefined && statusValue !== null) ||
    (reviews === null && reviewsValue !== undefined && reviewsValue !== null) ||
    (restrictions === null &&
      body.restrictions !== null &&
      body.restrictions !== undefined) ||
    Object.values(booleans).some((value) => value === null)
  ) {
    return invalid('an invalid default-branch protection response');
  }
  return {
    problem: null,
    value: {
      ...booleans,
      [REQUIRED_REVIEWS]: reviews,
      [REQUIRED_CHECKS]: status,
      restrictions,
    },
  };
};
