import { apiError, HTTP_NO_CONTENT, HTTP_OK, request } from './github-api';
import { subsetMatches } from './github-diff';
import type { ReportAction } from './github-environment-branch-apply';
import { reconcileBranchPolicies } from './github-environment-transition-apply';
import {
  environmentPath,
  fetchLiveEnvironment,
  type LiveEnvironment,
} from './github-environments';
import { isRecord } from './github-settings';

const WAIT_TIMER = 'wait_timer';
const PREVENT_SELF_REVIEW = 'prevent_self_review';
const DEPLOYMENT_BRANCH_POLICY = 'deployment_branch_policy';
const DEPLOYMENT_BRANCH_POLICIES = 'deployment_branch_policies';
const CUSTOM_DEPLOYMENT_PROTECTION_RULES = 'custom_deployment_protection_rules';
const PROTECTION_KEYS = [
  WAIT_TIMER,
  PREVENT_SELF_REVIEW,
  'reviewers',
  DEPLOYMENT_BRANCH_POLICY,
] as const;

type ApplyContext = {
  readonly token: string;
  readonly path: string;
  readonly name: string;
};

const usesCustomPolicies = (policy: unknown): boolean =>
  isRecord(policy) && policy.custom_branch_policies === true;

const updateProtection = async (
  context: ApplyContext,
  declared: Readonly<Record<string, unknown>>,
  live: LiveEnvironment,
): Promise<string | null> => {
  const protectionDrifted =
    live.environment !== null &&
    PROTECTION_KEYS.some(
      (key) => !subsetMatches(declared[key], live.environment?.[key]),
    );
  if (!(live.missing || protectionDrifted)) {
    return null;
  }
  const updated = await request(context.token, 'PUT', context.path, {
    [WAIT_TIMER]: declared[WAIT_TIMER],
    [PREVENT_SELF_REVIEW]: declared[PREVENT_SELF_REVIEW],
    reviewers: declared.reviewers,
    [DEPLOYMENT_BRANCH_POLICY]: declared[DEPLOYMENT_BRANCH_POLICY],
  });
  if (updated.status !== HTTP_OK) {
    throw new Error(
      apiError(`updating environment "${context.name}"`, updated),
    );
  }
  return `${live.missing ? 'created' : 'updated'} environment "${context.name}" protection`;
};

const deleteCustomProtectionRules = async (
  context: ApplyContext,
  rules: ReadonlyArray<Readonly<Record<string, unknown>>>,
  reportAction: ReportAction,
): Promise<ReadonlyArray<string>> => {
  const actions: Array<string> = [];
  for (const rule of rules) {
    // biome-ignore lint/performance/noAwaitInLoops: GitHub write requests are intentionally serialized to avoid secondary rate limits.
    const deleted = await request(
      context.token,
      'DELETE',
      `${context.path}/deployment_protection_rules/${rule.id}`,
    );
    const app = isRecord(rule.app) ? rule.app : {};
    if (deleted.status !== HTTP_NO_CONTENT) {
      throw new Error(
        apiError(
          `deleting custom deployment protection rule "${String(app.slug)}" from "${context.name}"`,
          deleted,
        ),
      );
    }
    const action = `deleted undeclared custom deployment protection rule "${String(app.slug)}" from environment "${context.name}"`;
    actions.push(action);
    reportAction(action);
  }
  return actions;
};

export const applyEnvironment = async (
  token: string,
  repo: string,
  declared: Readonly<Record<string, unknown>>,
  reportAction: ReportAction = () => undefined,
): Promise<ReadonlyArray<string>> => {
  const name = String(declared.name);
  const path = environmentPath(repo, name);
  const context = { token, path, name };
  const live = await fetchLiveEnvironment(token, repo, name);
  if (live.problem !== null) {
    throw new Error(live.problem);
  }
  const livePolicies = Array.isArray(
    live.environment?.[DEPLOYMENT_BRANCH_POLICIES],
  )
    ? live.environment[DEPLOYMENT_BRANCH_POLICIES].filter(isRecord)
    : [];
  const declaredPolicies = Array.isArray(declared[DEPLOYMENT_BRANCH_POLICIES])
    ? declared[DEPLOYMENT_BRANCH_POLICIES].filter(isRecord)
    : [];
  const customProtectionRules = Array.isArray(
    live.environment?.[CUSTOM_DEPLOYMENT_PROTECTION_RULES],
  )
    ? live.environment[CUSTOM_DEPLOYMENT_PROTECTION_RULES].filter(isRecord)
    : [];
  const actions = [
    ...(await reconcileBranchPolicies({
      context,
      declaredPolicies,
      declaredUsesCustom: usesCustomPolicies(
        declared[DEPLOYMENT_BRANCH_POLICY],
      ),
      livePolicies,
      liveUsesCustom: usesCustomPolicies(
        live.environment?.[DEPLOYMENT_BRANCH_POLICY],
      ),
      reportAction,
      updateProtection: () => updateProtection(context, declared, live),
    })),
  ];
  const deletedCustom = await deleteCustomProtectionRules(
    context,
    customProtectionRules,
    reportAction,
  );
  actions.push(...deletedCustom);
  return actions;
};
