import { apiError, HTTP_NO_CONTENT, HTTP_OK, request } from './github-api';
import { diffEnvironment } from './github-diff';
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

type ReportAction = (action: string) => void;

type ApplyContext = {
  readonly token: string;
  readonly path: string;
  readonly name: string;
};

const policyKey = (policy: Readonly<Record<string, unknown>>): string =>
  `${String(policy.type)}:${String(policy.name)}`;

const updateProtection = async (
  context: ApplyContext,
  declared: Readonly<Record<string, unknown>>,
  live: LiveEnvironment,
): Promise<string | null> => {
  const protectionDrifted =
    live.environment !== null &&
    diffEnvironment(declared, live.environment).some(
      (problem) =>
        !(
          problem.includes(DEPLOYMENT_BRANCH_POLICIES) ||
          problem.includes(CUSTOM_DEPLOYMENT_PROTECTION_RULES)
        ),
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

const deleteUndeclaredPolicies = async (
  context: ApplyContext,
  livePolicies: ReadonlyArray<Readonly<Record<string, unknown>>>,
  declaredKeys: ReadonlySet<string>,
  reportAction: ReportAction,
): Promise<ReadonlyArray<string>> => {
  const actions: Array<string> = [];
  for (const policy of livePolicies) {
    if (!declaredKeys.has(policyKey(policy))) {
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
      actions.push(action);
      reportAction(action);
    }
  }
  return actions;
};

const createMissingPolicies = async (
  context: ApplyContext,
  declaredPolicies: ReadonlyArray<Readonly<Record<string, unknown>>>,
  liveKeys: ReadonlySet<string>,
  reportAction: ReportAction,
): Promise<ReadonlyArray<string>> => {
  const actions: Array<string> = [];
  for (const policy of declaredPolicies) {
    if (!liveKeys.has(policyKey(policy))) {
      // biome-ignore lint/performance/noAwaitInLoops: GitHub write requests are intentionally serialized to avoid secondary rate limits.
      const created = await request(
        context.token,
        'POST',
        `${context.path}/deployment-branch-policies`,
        { name: policy.name, type: policy.type },
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
  const actions: Array<string> = [];
  const protection = await updateProtection(context, declared, live);
  if (protection !== null) {
    actions.push(protection);
    reportAction(protection);
  }
  const created = await createMissingPolicies(
    context,
    declaredPolicies,
    new Set(livePolicies.map(policyKey)),
    reportAction,
  );
  actions.push(...created);
  const deleted = await deleteUndeclaredPolicies(
    context,
    livePolicies,
    new Set(declaredPolicies.map(policyKey)),
    reportAction,
  );
  actions.push(...deleted);
  const deletedCustom = await deleteCustomProtectionRules(
    context,
    customProtectionRules,
    reportAction,
  );
  actions.push(...deletedCustom);
  return actions;
};
