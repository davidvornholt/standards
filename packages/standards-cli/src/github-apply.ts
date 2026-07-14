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
import { diffRuleset } from './github-diff';
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

export const applyPrefetchedRulesets = async ({
  declared,
  live,
  reportAction,
  repo,
  token,
}: ApplyRulesetsInput): Promise<ReadonlyArray<string>> => {
  if (live.rulesets === null) {
    throw new Error(live.problem ?? 'unable to read rulesets');
  }
  const liveByName = new Map(live.rulesets.map((r) => [String(r.name), r]));
  const declaredNames = new Set(declared.rulesets.map((r) => String(r.name)));
  const actions: Array<string> = [];
  for (const ruleset of declared.rulesets) {
    // biome-ignore lint/performance/noAwaitInLoops: GitHub advises against concurrent write requests (secondary rate limits); mutations run sequentially on purpose.
    const action = await reconcileRuleset(
      token,
      repo,
      ruleset,
      liveByName.get(String(ruleset.name)),
    );
    if (action !== null) {
      actions.push(action);
      reportAction(action);
    }
  }
  for (const [name, liveRuleset] of liveByName) {
    if (!declaredNames.has(name)) {
      // biome-ignore lint/performance/noAwaitInLoops: GitHub advises against concurrent write requests (secondary rate limits); mutations run sequentially on purpose.
      const action = await deleteRuleset(token, repo, name, liveRuleset);
      actions.push(action);
      reportAction(action);
    }
  }
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
