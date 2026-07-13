// GitHub Actions environment reads and reconciliation. This intentionally
// manages environment protection and deployment branch policy only; secret
// values are never listed, read, or written.

import { apiError, HTTP_NOT_FOUND, HTTP_OK, request } from './github-api';
import { isRecord } from './github-settings';

const WAIT_TIMER = 'wait_timer';
const PREVENT_SELF_REVIEW = 'prevent_self_review';
const DEPLOYMENT_BRANCH_POLICY = 'deployment_branch_policy';
const DEPLOYMENT_BRANCH_POLICIES = 'deployment_branch_policies';
const PROTECTION_RULES = 'protection_rules';
const CUSTOM_BRANCH_POLICIES = 'custom_branch_policies';
const BRANCH_POLICIES = 'branch_policies';
const TOTAL_COUNT = 'total_count';
const POLICIES_PER_PAGE = 100;

export type LiveEnvironment = {
  readonly environment: Readonly<Record<string, unknown>> | null;
  readonly missing: boolean;
  readonly problem: string | null;
};

export const environmentPath = (repo: string, name: string): string =>
  `/repos/${repo}/environments/${encodeURIComponent(name)}`;

const protectionRule = (
  rules: unknown,
  type: string,
): Readonly<Record<string, unknown>> | undefined =>
  Array.isArray(rules)
    ? rules.filter(isRecord).find((rule) => rule.type === type)
    : undefined;

const normalizeReviewers = (
  rule: Readonly<Record<string, unknown>> | undefined,
): ReadonlyArray<Readonly<Record<string, unknown>>> => {
  if (!Array.isArray(rule?.reviewers)) {
    return [];
  }
  return rule.reviewers.filter(isRecord).flatMap((entry) => {
    const reviewer = isRecord(entry.reviewer) ? entry.reviewer : undefined;
    return typeof entry.type === 'string' &&
      reviewer !== undefined &&
      Number.isInteger(reviewer.id)
      ? [{ type: entry.type, id: reviewer.id }]
      : [];
  });
};

type DeploymentPoliciesRead = {
  readonly policies: ReadonlyArray<Readonly<Record<string, unknown>>> | null;
  readonly problem: string | null;
};

const fetchDeploymentPolicies = async (
  token: string | null,
  path: string,
  name: string,
): Promise<DeploymentPoliciesRead> => {
  const collected: Array<Readonly<Record<string, unknown>>> = [];
  let totalCount: number | null = null;
  let page = 1;
  while (totalCount === null || collected.length < totalCount) {
    // biome-ignore lint/performance/noAwaitInLoops: API pagination is sequential because each response supplies the completion count.
    const response = await request(
      token,
      'GET',
      `${path}/deployment-branch-policies?per_page=${POLICIES_PER_PAGE}&page=${page}`,
    );
    if (
      response.status !== HTTP_OK ||
      !isRecord(response.body) ||
      !Number.isInteger(response.body[TOTAL_COUNT]) ||
      !Array.isArray(response.body[BRANCH_POLICIES])
    ) {
      return {
        policies: null,
        problem: apiError(
          `listing deployment policies for environment "${name}"`,
          response,
        ),
      };
    }
    totalCount ??= Number(response.body[TOTAL_COUNT]);
    const pagePolicies = response.body[BRANCH_POLICIES].filter(isRecord);
    if (pagePolicies.length === 0 && collected.length < totalCount) {
      return {
        policies: null,
        problem: `listing deployment policies for environment "${name}": GitHub returned fewer policies than total_count`,
      };
    }
    collected.push(...pagePolicies);
    page += 1;
  }
  return { policies: collected, problem: null };
};

export const fetchLiveEnvironment = async (
  token: string | null,
  repo: string,
  name: string,
): Promise<LiveEnvironment> => {
  const path = environmentPath(repo, name);
  const response = await request(token, 'GET', path);
  if (response.status === HTTP_NOT_FOUND) {
    return { environment: null, missing: true, problem: null };
  }
  if (response.status !== HTTP_OK || !isRecord(response.body)) {
    return {
      environment: null,
      missing: false,
      problem: apiError(`reading environment "${name}"`, response),
    };
  }
  const waitRule = protectionRule(response.body[PROTECTION_RULES], WAIT_TIMER);
  const reviewRule = protectionRule(
    response.body[PROTECTION_RULES],
    'required_reviewers',
  );
  const branchPolicy = isRecord(response.body[DEPLOYMENT_BRANCH_POLICY])
    ? response.body[DEPLOYMENT_BRANCH_POLICY]
    : {};
  let deploymentBranchPolicies: ReadonlyArray<Record<string, unknown>> = [];
  if (branchPolicy[CUSTOM_BRANCH_POLICIES] === true) {
    const policies = await fetchDeploymentPolicies(token, path, name);
    if (policies.policies === null) {
      return {
        environment: null,
        missing: false,
        problem: policies.problem,
      };
    }
    deploymentBranchPolicies = policies.policies.map((policy) => ({
      id: policy.id,
      name: policy.name,
      type: policy.type ?? 'branch',
    }));
  }
  return {
    environment: {
      name,
      [WAIT_TIMER]: waitRule?.[WAIT_TIMER] ?? 0,
      [PREVENT_SELF_REVIEW]: reviewRule?.[PREVENT_SELF_REVIEW] ?? false,
      reviewers: normalizeReviewers(reviewRule),
      [DEPLOYMENT_BRANCH_POLICY]: branchPolicy,
      [DEPLOYMENT_BRANCH_POLICIES]: deploymentBranchPolicies,
    },
    missing: false,
    problem: null,
  };
};
