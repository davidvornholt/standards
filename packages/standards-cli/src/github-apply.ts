// Ruleset reconciliation for `standards github --apply`: create, update, and
// delete live rulesets so they converge on exactly the declared set. Mutations
// throw on the first API failure so a partial apply is reported, not hidden.

import { type BeforeGithubMutation, noGithubMutationGuard } from './github-api';
import { diffRuleset, diffRulesets } from './github-diff';
import { deleteVerifiedUndeclaredRuleset } from './github-ruleset-deletion';
import { reconcileRuleset } from './github-ruleset-reconcile';
import { fetchLiveRulesets, type LiveRulesets } from './github-rulesets';
import type { GithubSettings } from './github-settings';

type ReportAction = (action: string) => void;

type ApplyRulesetsInput = {
  readonly beforeMutation?: BeforeGithubMutation;
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
  beforeMutation = noGithubMutationGuard,
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
    const action = await reconcileRuleset({
      beforeMutation,
      liveRuleset: liveByName.get(String(ruleset.name)),
      repo,
      ruleset,
      token,
    });
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
      if (declared.defaultBranchProtection === null) {
        throw new Error(
          `refusing to delete undeclared ruleset "${name}" without declared classic default-branch protection`,
        );
      }
      // biome-ignore lint/performance/noAwaitInLoops: GitHub writes and their fresh safety proofs are intentionally serialized.
      const action = await deleteVerifiedUndeclaredRuleset({
        declaredNames,
        beforeMutation,
        defaultBranchProtection: declared.defaultBranchProtection,
        liveRuleset,
        name,
        repo,
        token,
      });
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
