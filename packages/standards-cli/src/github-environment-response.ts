import {
  isPositiveSafeInteger,
  MAX_REVIEWERS,
  MAX_WAIT_TIMER,
} from './github-environment-settings';
import { isRecord } from './github-settings-value';

const WAIT_TIMER = 'wait_timer';
const REQUIRED_REVIEWERS = 'required_reviewers';
const BRANCH_POLICY = 'branch_policy';
const PROTECTION_TYPES = new Set([
  WAIT_TIMER,
  REQUIRED_REVIEWERS,
  BRANCH_POLICY,
]);

type DecodeResult<T> = {
  readonly problem: string | null;
  readonly value: T | null;
};

export type DecodedEnvironment = {
  readonly branchPolicy: Readonly<Record<string, unknown>> | null;
  readonly preventSelfReview: boolean;
  readonly reviewers: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly waitTimer: number;
};

const invalid = <T>(context: string, detail: string): DecodeResult<T> => ({
  problem: `${context}: GitHub returned ${detail}`,
  value: null,
});

const decodeReviewers = (
  value: unknown,
  context: string,
): DecodeResult<ReadonlyArray<Readonly<Record<string, unknown>>>> => {
  if (!Array.isArray(value) || value.length > MAX_REVIEWERS) {
    return invalid(context, 'an invalid required-reviewers list');
  }
  const reviewers: Array<Readonly<Record<string, unknown>>> = [];
  for (const entry of value) {
    const reviewer = isRecord(entry) ? entry.reviewer : null;
    if (
      !isRecord(entry) ||
      (entry.type !== 'User' && entry.type !== 'Team') ||
      !isRecord(reviewer) ||
      !isPositiveSafeInteger(reviewer.id)
    ) {
      return invalid(context, 'an invalid required-reviewer identity');
    }
    reviewers.push({ id: reviewer.id, type: entry.type });
  }
  return { problem: null, value: reviewers };
};

type DecodedProtectionRules = Omit<DecodedEnvironment, 'branchPolicy'>;

const decodeWaitTimer = (
  rule: Readonly<Record<string, unknown>>,
  context: string,
): DecodeResult<number> =>
  Number.isSafeInteger(rule.wait_timer) &&
  Number(rule.wait_timer) >= 0 &&
  Number(rule.wait_timer) <= MAX_WAIT_TIMER
    ? { problem: null, value: Number(rule.wait_timer) }
    : invalid(context, 'an invalid wait-timer protection rule');

const decodeRequiredReviewers = (
  rule: Readonly<Record<string, unknown>>,
  context: string,
): DecodeResult<Omit<DecodedProtectionRules, 'waitTimer'>> => {
  if (typeof rule.prevent_self_review !== 'boolean') {
    return invalid(context, 'an invalid required-reviewers rule');
  }
  const decoded = decodeReviewers(rule.reviewers, context);
  return decoded.value === null
    ? { problem: decoded.problem, value: null }
    : {
        problem: null,
        value: {
          preventSelfReview: rule.prevent_self_review,
          reviewers: decoded.value,
        },
      };
};

const decodeProtectionRules = (
  rules: ReadonlyArray<unknown>,
  context: string,
  branchPolicy: Readonly<Record<string, unknown>> | null,
): DecodeResult<DecodedProtectionRules> => {
  const typedRules = rules.filter(isRecord);
  if (
    typedRules.length !== rules.length ||
    typedRules.some(
      (rule) =>
        typeof rule.type !== 'string' || !PROTECTION_TYPES.has(rule.type),
    )
  ) {
    return invalid(context, 'an unsupported or invalid protection rule');
  }
  const branchRules = typedRules.filter((rule) => rule.type === BRANCH_POLICY);
  if (
    branchRules.length !== (branchPolicy === null ? 0 : 1) ||
    branchRules.some((rule) => !isPositiveSafeInteger(rule.id))
  ) {
    return invalid(context, 'an inconsistent branch_policy protection rule');
  }
  const waitRules = typedRules.filter((rule) => rule.type === WAIT_TIMER);
  if (waitRules.length > 1) {
    return invalid(context, 'a duplicate wait_timer protection rule');
  }
  const wait =
    waitRules[0] === undefined
      ? { problem: null, value: 0 }
      : decodeWaitTimer(waitRules[0], context);
  if (wait.value === null) {
    return { problem: wait.problem, value: null };
  }
  const reviewRules = typedRules.filter(
    (rule) => rule.type === REQUIRED_REVIEWERS,
  );
  if (reviewRules.length > 1) {
    return invalid(context, 'a duplicate required_reviewers protection rule');
  }
  const review =
    reviewRules[0] === undefined
      ? { problem: null, value: { preventSelfReview: false, reviewers: [] } }
      : decodeRequiredReviewers(reviewRules[0], context);
  if (review.value === null) {
    return { problem: review.problem, value: null };
  }
  return {
    problem: null,
    value: { ...review.value, waitTimer: wait.value },
  };
};

export const decodeEnvironmentResponse = (
  body: unknown,
  name: string,
): DecodeResult<DecodedEnvironment> => {
  const context = `reading environment "${name}"`;
  if (
    !isRecord(body) ||
    typeof body.name !== 'string' ||
    body.name.toLowerCase() !== name.toLowerCase() ||
    !Array.isArray(body.protection_rules)
  ) {
    return invalid(context, 'an invalid environment response');
  }
  const policy = body.deployment_branch_policy;
  if (
    policy !== null &&
    (!isRecord(policy) ||
      typeof policy.protected_branches !== 'boolean' ||
      typeof policy.custom_branch_policies !== 'boolean' ||
      policy.protected_branches === policy.custom_branch_policies)
  ) {
    return invalid(context, 'an invalid deployment branch policy');
  }
  const protection = decodeProtectionRules(
    body.protection_rules,
    context,
    policy as Readonly<Record<string, unknown>> | null,
  );
  if (protection.value === null) {
    return { problem: protection.problem, value: null };
  }
  return {
    problem: null,
    value: {
      branchPolicy: policy,
      ...protection.value,
    },
  };
};
