import {
  type BranchApplyContext,
  createMissingPolicies,
  type DeploymentPolicy,
  deleteUndeclaredPolicies,
  type ReportAction,
  restorePolicies,
} from './github-environment-branch-apply';

type ReconcileOptions = {
  readonly context: BranchApplyContext;
  readonly declaredPolicies: ReadonlyArray<DeploymentPolicy>;
  readonly declaredUsesCustom: boolean;
  readonly livePolicies: ReadonlyArray<DeploymentPolicy>;
  readonly liveUsesCustom: boolean;
  readonly reportAction: ReportAction;
  readonly updateProtection: () => Promise<string | null>;
};

const policyName = (policy: DeploymentPolicy): string => String(policy.name);

const deletionAction = (
  context: BranchApplyContext,
  policy: DeploymentPolicy,
): string =>
  `deleted undeclared deployment policy "${policy.name}" from environment "${context.name}"`;

const updateAndReportProtection = async (
  updateProtection: () => Promise<string | null>,
  reportAction: ReportAction,
): Promise<ReadonlyArray<string>> => {
  const protection = await updateProtection();
  if (protection === null) {
    return [];
  }
  reportAction(protection);
  return [protection];
};

const compensateAndThrow = async (
  context: BranchApplyContext,
  deleted: ReadonlyArray<DeploymentPolicy>,
  error: unknown,
  reportAction: ReportAction,
): Promise<never> => {
  if (deleted.length === 0) {
    throw error;
  }
  const original = error instanceof Error ? error.message : String(error);
  const rollbackProblems = await restorePolicies(
    context,
    deleted,
    reportAction,
  );
  const rollback =
    rollbackProblems.length === 0
      ? 'compensation restored every deleted deployment policy'
      : `compensation failed: ${rollbackProblems.join('; ')}`;
  throw new Error(`${original}; ${rollback}`, { cause: error });
};

export const reconcileBranchPolicies = async (
  options: ReconcileOptions,
): Promise<ReadonlyArray<string>> => {
  const {
    context,
    declaredPolicies,
    declaredUsesCustom,
    livePolicies,
    liveUsesCustom,
    reportAction,
    updateProtection,
  } = options;
  const declaredNames = new Set(declaredPolicies.map(policyName));
  const actions: Array<string> = [];
  if (liveUsesCustom && !declaredUsesCustom) {
    const deleted = await deleteUndeclaredPolicies(
      context,
      livePolicies,
      declaredNames,
      reportAction,
    );
    actions.push(...deleted.map((policy) => deletionAction(context, policy)));
    try {
      actions.push(
        ...(await updateAndReportProtection(updateProtection, reportAction)),
      );
    } catch (error) {
      await compensateAndThrow(context, deleted, error, reportAction);
    }
    return actions;
  }
  actions.push(
    ...(await updateAndReportProtection(updateProtection, reportAction)),
  );
  if (!declaredUsesCustom) {
    return actions;
  }
  actions.push(
    ...(await createMissingPolicies(
      context,
      declaredPolicies,
      new Set(livePolicies.map(policyName)),
      reportAction,
    )),
  );
  if (liveUsesCustom) {
    const deleted = await deleteUndeclaredPolicies(
      context,
      livePolicies,
      declaredNames,
      reportAction,
    );
    actions.push(...deleted.map((policy) => deletionAction(context, policy)));
  }
  return actions;
};
