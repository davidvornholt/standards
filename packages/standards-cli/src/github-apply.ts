// Ruleset reconciliation for `standards github --apply`: create, update, and
// delete live rulesets so they converge on exactly the declared set. Mutations
// throw on the first API failure so a partial apply is reported, not hidden.

import {
  apiError,
  HTTP_CREATED,
  HTTP_NO_CONTENT,
  HTTP_OK,
  request,
} from './github-api';
import { diffRuleset, diffRulesets } from './github-diff';
import { fetchLiveRulesets, type LiveRulesets } from './github-rulesets';
import type { GithubSettings } from './github-settings';

type ReportAction = (action: string) => void;

const reconcileRuleset = async (
  token: string,
  repo: string,
  ruleset: Readonly<Record<string, unknown>>,
  liveRuleset: Readonly<Record<string, unknown>> | undefined,
): Promise<string | null> => {
  const name = String(ruleset.name);
  if (liveRuleset === undefined) {
    const created = await request(
      token,
      'POST',
      `/repos/${repo}/rulesets`,
      ruleset,
    );
    if (created.status !== HTTP_CREATED) {
      throw new Error(apiError(`creating ruleset "${name}"`, created));
    }
    return `created ruleset "${name}"`;
  }
  const diff = diffRuleset(ruleset, liveRuleset);
  if (diff.drifted.length === 0 && diff.unverifiable.length === 0) {
    return null;
  }
  const updated = await request(
    token,
    'PUT',
    `/repos/${repo}/rulesets/${liveRuleset.id}`,
    ruleset,
  );
  if (updated.status !== HTTP_OK) {
    throw new Error(apiError(`updating ruleset "${name}"`, updated));
  }
  return `updated ruleset "${name}"`;
};

const deleteRuleset = async (
  token: string,
  repo: string,
  name: string,
  liveRuleset: Readonly<Record<string, unknown>>,
): Promise<string> => {
  const deleted = await request(
    token,
    'DELETE',
    `/repos/${repo}/rulesets/${liveRuleset.id}`,
  );
  if (deleted.status !== HTTP_NO_CONTENT) {
    throw new Error(apiError(`deleting ruleset "${name}"`, deleted));
  }
  return `deleted undeclared ruleset "${name}"`;
};

type ApplyRulesetsInput = {
  readonly declared: GithubSettings;
  readonly live: LiveRulesets;
  readonly reportAction: ReportAction;
  readonly repo: string;
  readonly token: string;
};

const rulesetsOrThrow = (
  live: LiveRulesets,
  context: string,
): ReadonlyArray<Record<string, unknown>> => {
  if (live.rulesets === null) {
    throw new Error(`${context}: ${live.problem ?? 'unable to read rulesets'}`);
  }
  return live.rulesets;
};

const assertDeclaredRulesetsConverged = (
  declared: GithubSettings,
  liveRulesets: ReadonlyArray<Readonly<Record<string, unknown>>>,
): void => {
  const liveByName = new Map(
    liveRulesets.map((ruleset) => [String(ruleset.name), ruleset]),
  );
  const problems = declared.rulesets.flatMap((ruleset) => {
    const liveRuleset = liveByName.get(String(ruleset.name));
    if (liveRuleset === undefined) {
      return [`ruleset "${ruleset.name}" is missing after apply`];
    }
    const diff = diffRuleset(ruleset, liveRuleset);
    return [...diff.drifted, ...diff.unverifiable];
  });
  if (problems.length > 0) {
    throw new Error(
      `declared rulesets did not converge after apply: ${problems.join('; ')}`,
    );
  }
};

const assertExactRulesetState = (
  declared: GithubSettings,
  liveRulesets: ReadonlyArray<Readonly<Record<string, unknown>>>,
): void => {
  const diff = diffRulesets(declared.rulesets, liveRulesets);
  const problems = [...diff.drifted, ...diff.unverifiable];
  if (problems.length > 0) {
    throw new Error(
      `rulesets did not converge after apply: ${problems.join('; ')}`,
    );
  }
};

export const applyPrefetchedRulesets = async ({
  declared,
  live,
  reportAction,
  repo,
  token,
}: ApplyRulesetsInput): Promise<ReadonlyArray<string>> => {
  const initialRulesets = rulesetsOrThrow(live, 'reading initial rulesets');
  const liveByName = new Map(
    initialRulesets.map((ruleset) => [String(ruleset.name), ruleset]),
  );
  const declaredNames = new Set(declared.rulesets.map((r) => String(r.name)));
  const actions: Array<string> = [];
  let declaredMutationOccurred = false;
  for (const ruleset of declared.rulesets) {
    // biome-ignore lint/performance/noAwaitInLoops: GitHub advises against concurrent write requests (secondary rate limits); mutations run sequentially on purpose.
    const action = await reconcileRuleset(
      token,
      repo,
      ruleset,
      liveByName.get(String(ruleset.name)),
    );
    if (action !== null) {
      declaredMutationOccurred = true;
      actions.push(action);
      reportAction(action);
    }
  }
  const hasUndeclaredCandidate = [...liveByName.keys()].some(
    (name) => !declaredNames.has(name),
  );
  if (!(declaredMutationOccurred || hasUndeclaredCandidate)) {
    return actions;
  }
  const beforeDeletion = rulesetsOrThrow(
    await fetchLiveRulesets(token, repo, true),
    'verifying declared rulesets before deletion',
  );
  assertDeclaredRulesetsConverged(declared, beforeDeletion);
  const freshByName = new Map(
    beforeDeletion.map((ruleset) => [String(ruleset.name), ruleset]),
  );
  let deletionOccurred = false;
  for (const [name, liveRuleset] of freshByName) {
    if (!declaredNames.has(name)) {
      // biome-ignore lint/performance/noAwaitInLoops: GitHub advises against concurrent write requests (secondary rate limits); mutations run sequentially on purpose.
      const action = await deleteRuleset(token, repo, name, liveRuleset);
      deletionOccurred = true;
      actions.push(action);
      reportAction(action);
    }
  }
  if (!deletionOccurred) {
    assertExactRulesetState(declared, beforeDeletion);
    return actions;
  }
  const finalRulesets = rulesetsOrThrow(
    await fetchLiveRulesets(token, repo, true),
    'verifying final ruleset state',
  );
  assertExactRulesetState(declared, finalRulesets);
  return actions;
};

export const applyRulesets = async (
  token: string,
  repo: string,
  declared: GithubSettings,
  reportAction: ReportAction = () => undefined,
): Promise<ReadonlyArray<string>> =>
  applyPrefetchedRulesets({
    declared,
    live: await fetchLiveRulesets(token, repo, true),
    reportAction,
    repo,
    token,
  });
