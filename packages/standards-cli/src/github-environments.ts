// GitHub Actions environment reads and reconciliation. This intentionally
// manages environment protection and protected-branch policy only; secret
// values are never listed, read, or written.

import { apiError, HTTP_NOT_FOUND, HTTP_OK, request } from './github-api';
import { decodeCustomProtectionRules } from './github-custom-protection-response';
import { decodeEnvironmentResponse } from './github-environment-response';

const WAIT_TIMER = 'wait_timer';
const PREVENT_SELF_REVIEW = 'prevent_self_review';
const DEPLOYMENT_BRANCH_POLICY = 'deployment_branch_policy';
const CUSTOM_DEPLOYMENT_PROTECTION_RULES = 'custom_deployment_protection_rules';

export type LiveEnvironment = {
  readonly environment: Readonly<Record<string, unknown>> | null;
  readonly missing: boolean;
  readonly problem: string | null;
};

export const environmentPath = (repo: string, name: string): string =>
  `/repos/${repo}/environments/${encodeURIComponent(name)}`;

type CustomProtectionRulesRead = {
  readonly policies: ReadonlyArray<Readonly<Record<string, unknown>>> | null;
  readonly problem: string | null;
};

const fetchCustomProtectionRules = async (
  token: string | null,
  path: string,
  name: string,
): Promise<CustomProtectionRulesRead> => {
  const response = await request(
    token,
    'GET',
    `${path}/deployment_protection_rules`,
  );
  if (response.status !== HTTP_OK) {
    return {
      policies: null,
      problem: apiError(
        `listing custom deployment protection rules for environment "${name}"`,
        response,
      ),
    };
  }
  const decoded = decodeCustomProtectionRules(response.body, name);
  return decoded.value === null
    ? { policies: null, problem: decoded.problem }
    : { policies: decoded.value.rules, problem: null };
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
  const customProtectionRules = await fetchCustomProtectionRules(
    token,
    path,
    name,
  );
  if (customProtectionRules.policies === null) {
    return {
      environment: null,
      missing: false,
      problem: customProtectionRules.problem,
    };
  }
  return {
    environment: {
      name,
      [WAIT_TIMER]: decoded.value.waitTimer,
      [PREVENT_SELF_REVIEW]: decoded.value.preventSelfReview,
      reviewers: decoded.value.reviewers,
      [DEPLOYMENT_BRANCH_POLICY]: decoded.value.branchPolicy,
      [CUSTOM_DEPLOYMENT_PROTECTION_RULES]: customProtectionRules.policies,
    },
    missing: false,
    problem: null,
  };
};
