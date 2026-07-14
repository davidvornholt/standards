import { apiError, HTTP_NO_CONTENT, HTTP_OK, request } from './github-api';

export type ReportAction = (action: string) => void;

export type BranchApplyContext = {
  readonly token: string;
  readonly path: string;
  readonly name: string;
};

export type DeploymentPolicy = Readonly<Record<string, unknown>>;

const policyName = (policy: DeploymentPolicy): string => String(policy.name);

export const createMissingPolicies = async (
  context: BranchApplyContext,
  declaredPolicies: ReadonlyArray<DeploymentPolicy>,
  liveNames: ReadonlySet<string>,
  reportAction: ReportAction,
): Promise<ReadonlyArray<string>> => {
  const actions: Array<string> = [];
  for (const policy of declaredPolicies) {
    if (!liveNames.has(policyName(policy))) {
      // biome-ignore lint/performance/noAwaitInLoops: GitHub write requests are intentionally serialized to avoid secondary rate limits.
      const created = await request(
        context.token,
        'POST',
        `${context.path}/deployment-branch-policies`,
        { name: policy.name },
      );
      if (created.status !== HTTP_OK) {
        throw new Error(
          apiError(`creating deployment policy in "${context.name}"`, created),
        );
      }
      const action = `created deployment policy "${policy.name}" for environment "${context.name}"`;
      actions.push(action);
      reportAction(action);
    }
  }
  return actions;
};

export const deleteUndeclaredPolicies = async (
  context: BranchApplyContext,
  livePolicies: ReadonlyArray<DeploymentPolicy>,
  declaredNames: ReadonlySet<string>,
  reportAction: ReportAction,
): Promise<ReadonlyArray<DeploymentPolicy>> => {
  const deletedPolicies: Array<DeploymentPolicy> = [];
  for (const policy of livePolicies) {
    if (!declaredNames.has(policyName(policy))) {
      // biome-ignore lint/performance/noAwaitInLoops: GitHub write requests are intentionally serialized to avoid secondary rate limits.
      const deleted = await request(
        context.token,
        'DELETE',
        `${context.path}/deployment-branch-policies/${policy.id}`,
      );
      if (deleted.status !== HTTP_NO_CONTENT) {
        throw new Error(
          apiError(
            `deleting deployment policy from "${context.name}"`,
            deleted,
          ),
        );
      }
      const action = `deleted undeclared deployment policy "${policy.name}" from environment "${context.name}"`;
      deletedPolicies.push(policy);
      reportAction(action);
    }
  }
  return deletedPolicies;
};

export const restorePolicies = async (
  context: BranchApplyContext,
  policies: ReadonlyArray<DeploymentPolicy>,
  reportAction: ReportAction,
): Promise<ReadonlyArray<string>> => {
  const problems: Array<string> = [];
  for (const policy of policies) {
    // biome-ignore lint/performance/noAwaitInLoops: Compensation requests are intentionally serialized and all failures are collected.
    const restored = await request(
      context.token,
      'POST',
      `${context.path}/deployment-branch-policies`,
      { name: policy.name },
    );
    if (restored.status === HTTP_OK) {
      reportAction(
        `restored deployment policy "${policy.name}" for environment "${context.name}" after failed protection update`,
      );
    } else {
      problems.push(
        apiError(
          `restoring deployment policy "${policy.name}" in "${context.name}"`,
          restored,
        ),
      );
    }
  }
  return problems;
};
