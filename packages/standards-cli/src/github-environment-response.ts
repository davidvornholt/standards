import { MAX_REVIEWERS, MAX_WAIT_TIMER } from './github-environment-settings';
import { isRecord } from './github-settings';

const WAIT_TIMER = 'wait_timer';
const REQUIRED_REVIEWERS = 'required_reviewers';

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

export type DecodedPolicyPage = {
  readonly policies: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly totalCount: number;
};

const invalid = <T>(context: string, detail: string): DecodeResult<T> => ({
  problem: `${context}: GitHub returned ${detail}`,
  value: null,
});

const positiveSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

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
      !positiveSafeInteger(reviewer.id)
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
): DecodeResult<DecodedProtectionRules> => {
  const typedRules = rules.filter(isRecord);
  if (
    typedRules.length !== rules.length ||
    typedRules.some((rule) => typeof rule.type !== 'string')
  ) {
    return invalid(context, 'an invalid protection rule');
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
  const protection = decodeProtectionRules(body.protection_rules, context);
  if (protection.value === null) {
    return { problem: protection.problem, value: null };
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
  return {
    problem: null,
    value: {
      branchPolicy: policy,
      ...protection.value,
    },
  };
};

export const decodePolicyPage = (
  body: unknown,
  name: string,
): DecodeResult<DecodedPolicyPage> => {
  const context = `listing deployment policies for environment "${name}"`;
  if (
    !(isRecord(body) && Number.isSafeInteger(body.total_count)) ||
    Number(body.total_count) < 0 ||
    !Array.isArray(body.branch_policies)
  ) {
    return invalid(context, 'an invalid deployment-policy page');
  }
  const policies: Array<Readonly<Record<string, unknown>>> = [];
  for (const policy of body.branch_policies) {
    if (
      !(isRecord(policy) && positiveSafeInteger(policy.id)) ||
      typeof policy.name !== 'string' ||
      policy.name.length === 0 ||
      (policy.type !== 'branch' && policy.type !== 'tag')
    ) {
      return invalid(context, 'an invalid deployment policy');
    }
    policies.push({ id: policy.id, name: policy.name, type: policy.type });
  }
  return {
    problem: null,
    value: { policies, totalCount: Number(body.total_count) },
  };
};
