// GitHub Actions environment reads and reconciliation. This intentionally
// manages environment protection and deployment branch policy only; secret
// values are never listed, read, or written.

import { apiError, HTTP_NOT_FOUND, HTTP_OK, request } from './github-api';
import {
  decodeEnvironmentResponse,
  decodePolicyPage,
} from './github-environment-response';

const WAIT_TIMER = 'wait_timer';
const PREVENT_SELF_REVIEW = 'prevent_self_review';
const DEPLOYMENT_BRANCH_POLICY = 'deployment_branch_policy';
const DEPLOYMENT_BRANCH_POLICIES = 'deployment_branch_policies';
const CUSTOM_BRANCH_POLICIES = 'custom_branch_policies';
const POLICIES_PER_PAGE = 100;

export type LiveEnvironment = {
  readonly environment: Readonly<Record<string, unknown>> | null;
  readonly missing: boolean;
  readonly problem: string | null;
};

export const environmentPath = (repo: string, name: string): string =>
  `/repos/${repo}/environments/${encodeURIComponent(name)}`;

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
    if (response.status !== HTTP_OK) {
      return {
        policies: null,
        problem: apiError(
          `listing deployment policies for environment "${name}"`,
          response,
        ),
      };
    }
    const decoded = decodePolicyPage(response.body, name);
    if (decoded.value === null) {
      return { policies: null, problem: decoded.problem };
    }
    if (totalCount !== null && decoded.value.totalCount !== totalCount) {
      return {
        policies: null,
        problem: `listing deployment policies for environment "${name}": GitHub changed total_count during pagination`,
      };
    }
    totalCount ??= decoded.value.totalCount;
    const pagePolicies = decoded.value.policies;
    if (pagePolicies.length === 0 && collected.length < totalCount) {
      return {
        policies: null,
        problem: `listing deployment policies for environment "${name}": GitHub returned fewer policies than total_count`,
      };
    }
    if (collected.length + pagePolicies.length > totalCount) {
      return {
        policies: null,
        problem: `listing deployment policies for environment "${name}": GitHub returned more policies than total_count`,
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
  if (response.status !== HTTP_OK) {
    return {
      environment: null,
      missing: false,
      problem: apiError(`reading environment "${name}"`, response),
    };
  }
  const decoded = decodeEnvironmentResponse(response.body, name);
  if (decoded.value === null) {
    return {
      environment: null,
      missing: false,
      problem: decoded.problem,
    };
  }
  const { branchPolicy } = decoded.value;
  let deploymentBranchPolicies: ReadonlyArray<Record<string, unknown>> = [];
  if (branchPolicy?.[CUSTOM_BRANCH_POLICIES] === true) {
    const policies = await fetchDeploymentPolicies(token, path, name);
    if (policies.policies === null) {
      return {
        environment: null,
        missing: false,
        problem: policies.problem,
      };
    }
    deploymentBranchPolicies = policies.policies;
  }
  return {
    environment: {
      name,
      [WAIT_TIMER]: decoded.value.waitTimer,
      [PREVENT_SELF_REVIEW]: decoded.value.preventSelfReview,
      reviewers: decoded.value.reviewers,
      [DEPLOYMENT_BRANCH_POLICY]: branchPolicy,
      [DEPLOYMENT_BRANCH_POLICIES]: deploymentBranchPolicies,
    },
    missing: false,
    problem: null,
  };
};
