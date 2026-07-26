// Loading the live repository rulesets. This lives outside github-api.ts
// because the exhaustive pagination it needs (github-paginate.ts) is itself
// built on github-api.ts, and calling it from there would be a mutual import.

import { apiError, HTTP_OK, request } from './github-api';
import { listAllPages } from './github-paginate';
import { isRecord } from './github-settings-parse';

export type LiveRulesets = {
  readonly rulesets: ReadonlyArray<Record<string, unknown>> | null;
  readonly problem: string | null;
};

// Only repository-sourced rulesets are managed; org-level rulesets a consumer
// inherits are outside this declaration's authority. The list really
// paginates — GitHub serves 30 per page by default and `includes_parents`
// defaults to true — so a single-page read would hide an undeclared ruleset
// that happens to land on page two, and the "not declared" branch would never
// fire for it.
//
// listAllPages throws, but the drift collector tells a ruleset read failure
// apart from a label read failure by the returned problem string, not by the
// exception, so the throw is converted here rather than propagated.
export const fetchLiveRulesets = async (
  token: string | null,
  repo: string,
): Promise<LiveRulesets> => {
  let summaries: ReadonlyArray<unknown>;
  try {
    summaries = await listAllPages(
      token,
      `/repos/${repo}/rulesets`,
      'listing rulesets',
    );
  } catch (error) {
    return {
      rulesets: null,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
  const repoOwned = summaries
    .filter(isRecord)
    .filter((ruleset) => ruleset.source_type === 'Repository');
  const detailed = await Promise.all(
    repoOwned.map((ruleset) =>
      request(token, 'GET', `/repos/${repo}/rulesets/${ruleset.id}`),
    ),
  );
  const failed = detailed.find((response) => response.status !== HTTP_OK);
  if (failed !== undefined) {
    return { rulesets: null, problem: apiError('reading a ruleset', failed) };
  }
  return {
    rulesets: detailed.map((response) => response.body).filter(isRecord),
    problem: null,
  };
};
