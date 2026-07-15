import {
  apiError,
  type BeforeGithubMutation,
  HTTP_OK,
  mutate,
  noGithubMutationGuard,
} from './github-api';
import { diffEnvironment, subsetMatches } from './github-diff';
import {
  customProtectionRulesFrom,
  deleteCustomProtectionRules,
} from './github-environment-custom-apply';
import {
  environmentPath,
  fetchLiveEnvironment,
  type LiveEnvironment,
} from './github-environments';

const WAIT_TIMER = 'wait_timer';
const PREVENT_SELF_REVIEW = 'prevent_self_review';
const DEPLOYMENT_BRANCH_POLICY = 'deployment_branch_policy';
const PROTECTION_KEYS = [
  WAIT_TIMER,
  PREVENT_SELF_REVIEW,
  'reviewers',
  DEPLOYMENT_BRANCH_POLICY,
] as const;

type ApplyContext = {
  readonly beforeMutation: BeforeGithubMutation;
  readonly token: string;
  readonly path: string;
  readonly name: string;
};
type ReportAction = (action: string) => void;
const requireEnvironment = (
  name: string,
  live: LiveEnvironment,
): Readonly<Record<string, unknown>> => {
  if (live.problem !== null) {
    throw new Error(live.problem);
  }
  if (live.missing || live.environment === null) {
    throw new Error(`Environment "${name}" is missing on readback`);
  }
  return live.environment;
};

const protectionMatches = (
  declared: Readonly<Record<string, unknown>>,
  live: Readonly<Record<string, unknown>>,
): boolean =>
  PROTECTION_KEYS.every((key) => subsetMatches(declared[key], live[key]));

const assertProtectionConverged = (
  declared: Readonly<Record<string, unknown>>,
  live: LiveEnvironment,
): void => {
  const name = String(declared.name);
  if (!protectionMatches(declared, requireEnvironment(name, live))) {
    throw new Error(
      `Environment "${name}" protection did not match the declaration on verification readback`,
    );
  }
};

const assertEnvironmentConverged = (
  declared: Readonly<Record<string, unknown>>,
  live: LiveEnvironment,
): void => {
  const name = String(declared.name);
  const drift = diffEnvironment(declared, requireEnvironment(name, live));
  if (drift.length > 0) {
    throw new Error(
      `Environment "${name}" did not match the declaration after apply: ${drift.join('; ')}`,
    );
  }
};

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
  const updated = await mutate({
    beforeMutation: context.beforeMutation,
    body: {
      [WAIT_TIMER]: declared[WAIT_TIMER],
      [PREVENT_SELF_REVIEW]: declared[PREVENT_SELF_REVIEW],
      reviewers: declared.reviewers,
      [DEPLOYMENT_BRANCH_POLICY]: declared[DEPLOYMENT_BRANCH_POLICY],
    },
    method: 'PUT',
    path: context.path,
    token: context.token,
  });
  if (updated.status !== HTTP_OK) {
    throw new Error(
      apiError(`updating environment "${context.name}"`, updated),
    );
  }
  return `${live.missing ? 'created' : 'updated'} environment "${context.name}" protection`;
};

type ApplyEnvironmentInput = {
  readonly beforeMutation?: BeforeGithubMutation;
  readonly declared: Readonly<Record<string, unknown>>;
  readonly live: LiveEnvironment;
  readonly reportAction: ReportAction;
  readonly repo: string;
  readonly token: string;
};

export const applyPrefetchedEnvironment = async ({
  beforeMutation = noGithubMutationGuard,
  declared,
  live,
  reportAction,
  repo,
  token,
}: ApplyEnvironmentInput): Promise<ReadonlyArray<string>> => {
  const name = String(declared.name);
  const path = environmentPath(repo, name);
  const context = { beforeMutation, token, path, name };
  if (live.problem !== null) {
    throw new Error(live.problem);
  }
  const actions: Array<string> = [];
  const protection = await updateProtection(context, declared, live);
  if (protection !== null) {
    actions.push(protection);
    reportAction(protection);
  }
  const initialCustomProtectionRules = customProtectionRulesFrom(live);
  const needsVerification =
    protection !== null || initialCustomProtectionRules.length > 0;
  const verifiedLive = needsVerification
    ? await fetchLiveEnvironment(token, repo, name)
    : live;
  if (needsVerification) {
    assertProtectionConverged(declared, verifiedLive);
  }
  const customProtectionRules = customProtectionRulesFrom(verifiedLive);
  const deletedCustom = await deleteCustomProtectionRules({
    ...context,
    reportAction,
    rules: customProtectionRules,
  });
  actions.push(...deletedCustom);
  if (deletedCustom.length > 0) {
    assertEnvironmentConverged(
      declared,
      await fetchLiveEnvironment(token, repo, name),
    );
  } else if (protection !== null) {
    assertEnvironmentConverged(declared, verifiedLive);
  }
  return actions;
};

export const applyEnvironment = async (
  token: string,
  repo: string,
  declared: Readonly<Record<string, unknown>>,
  reportAction: ReportAction = () => undefined,
): Promise<ReadonlyArray<string>> =>
  applyPrefetchedEnvironment({
    declared,
    live: await fetchLiveEnvironment(token, repo, String(declared.name)),
    reportAction,
    repo,
    token,
  });
