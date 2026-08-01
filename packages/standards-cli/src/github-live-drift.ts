// Drift collection for `standards github --check`: compares the live GitHub
// repository against the merged declaration and fails closed on state the
// token cannot see. Command wiring lives in github-commands.ts.

import {
  apiError,
  HTTP_FORBIDDEN,
  HTTP_OK,
  HTTP_UNAUTHORIZED,
  request,
  resolveGithubRepo,
  resolveToken,
} from './github-api';
import { resolveHiddenBypassActors } from './github-bypass-actors';
import {
  enforceableRepositorySettings,
  MERGE_SETTINGS_VISIBILITY_ADVICE,
  optOutEligibilityProblem,
  unverifiableProblem,
} from './github-command-shared';
import { diffRepositorySettings } from './github-diff';
import {
  fetchBypassActorCountsViaGraphql,
  fetchMergeSettingsViaGraphql,
} from './github-graphql';
import { diffLabels, fetchLiveLabels } from './github-labels';
import { GithubListResponseError } from './github-paginate';
import { fetchLiveRulesets } from './github-ruleset-api';
import { diffRulesets } from './github-ruleset-diff';
import {
  GRAPHQL_NOT_CONSULTED,
  isHiddenBypassActors,
  rulesetVisibilityProblems,
} from './github-ruleset-visibility';
import { type GithubSettings, isRecord } from './github-settings-parse';

const LABEL_VISIBILITY_PROBLEM =
  'declared labels not visible to this token, so the gate cannot verify them. Label reads need issues: read (or pull-requests: read); the canonical check aggregator job already grants issues: read, so in CI this points at a stale synced workflow or an organization policy restricting the workflow token rather than anything to change in the declaration. Locally, use a token with one of those permissions';
const PERMISSION_DENIAL_MESSAGES: ReadonlySet<string> = new Set([
  'Resource not accessible by integration',
  'Resource not accessible by personal access token',
]);

const isLabelPermissionDenial = (error: unknown): boolean =>
  error instanceof GithubListResponseError &&
  (error.status === HTTP_UNAUTHORIZED ||
    (error.status === HTTP_FORBIDDEN &&
      isRecord(error.responseBody) &&
      typeof error.responseBody.message === 'string' &&
      PERMISSION_DENIAL_MESSAGES.has(error.responseBody.message)));

const repositoryDrift = async (
  token: string | null,
  repo: string,
  declared: GithubSettings,
): Promise<ReadonlyArray<string>> => {
  const repoResponse = await request(token, 'GET', `/repos/${repo}`);
  if (repoResponse.status !== HTTP_OK || !isRecord(repoResponse.body)) {
    return [apiError(`reading repository ${repo}`, repoResponse)];
  }
  const eligibilityProblem = optOutEligibilityProblem(
    repo,
    declared,
    repoResponse.body,
  );
  if (eligibilityProblem !== null) {
    return [eligibilityProblem];
  }
  const declaredRepository = enforceableRepositorySettings(declared);
  const diff = diffRepositorySettings(declaredRepository, repoResponse.body);
  if (diff.unverifiable.length === 0) {
    return diff.drifted;
  }
  // REST hides merge settings from read-only tokens; retry the invisible
  // keys over GraphQL before failing the gate.
  const fallback = await fetchMergeSettingsViaGraphql(
    token,
    repo,
    diff.unverifiable,
  );
  const rediff = diffRepositorySettings(declaredRepository, {
    ...repoResponse.body,
    ...fallback,
  });
  return [
    ...rediff.drifted,
    ...unverifiableProblem(
      'repository setting(s)',
      rediff.unverifiable,
      MERGE_SETTINGS_VISIBILITY_ADVICE,
    ),
  ];
};

// The live rulesets GraphQL answered a bypass-actor count for, named as the
// REST response names them so the advice can say whether a hidden list was
// counted-and-matched or never answered for at all.
const countedRulesetNames = (
  live: ReadonlyArray<Readonly<Record<string, unknown>>>,
  counts: ReadonlyMap<number, number>,
): ReadonlySet<string> =>
  new Set(
    live
      .filter(
        (ruleset) => typeof ruleset.id === 'number' && counts.has(ruleset.id),
      )
      .map((ruleset) => String(ruleset.name)),
  );

const rulesetDrift = async (
  token: string | null,
  repo: string,
  declared: GithubSettings,
): Promise<ReadonlyArray<string>> => {
  if (declared.rulesetEnforcement === 'unavailable-on-plan') {
    return [];
  }
  const live = await fetchLiveRulesets(token, repo);
  if (live.rulesets === null) {
    return [live.problem ?? 'unable to read rulesets'];
  }
  const diff = diffRulesets(declared.rulesets, live.rulesets);
  if (!diff.unverifiable.some(isHiddenBypassActors)) {
    return [
      ...diff.drifted,
      ...rulesetVisibilityProblems(diff.unverifiable, GRAPHQL_NOT_CONSULTED),
    ];
  }
  // REST hides bypass actors from every non-admin token and from installation
  // tokens outright; retry the hidden lists as GraphQL counts before failing
  // the gate.
  const answered = await fetchBypassActorCountsViaGraphql(token, repo);
  const rediff = diffRulesets(
    declared.rulesets,
    resolveHiddenBypassActors(
      declared.rulesets,
      live.rulesets,
      answered.counts,
    ),
  );
  return [
    ...rediff.drifted,
    ...rulesetVisibilityProblems(rediff.unverifiable, {
      countedNames: countedRulesetNames(live.rulesets, answered.counts),
      failure: answered.failure,
    }),
  ];
};

export const collectLiveDrift = async (
  consumer: string,
  declared: GithubSettings,
): Promise<ReadonlyArray<string>> => {
  const repo = resolveGithubRepo(consumer);
  if (repo === null) {
    return ['cannot determine the GitHub repository from the origin remote'];
  }
  const token = resolveToken();
  try {
    // No declared labels means nothing to verify — skipping the fetch is
    // exact, not lenient.
    const labelDrift =
      declared.labels.length === 0
        ? []
        : diffLabels(declared.labels, await fetchLiveLabels(token, repo));
    return [
      ...(await repositoryDrift(token, repo, declared)),
      ...(await rulesetDrift(token, repo, declared)),
      ...labelDrift,
    ];
  } catch (error) {
    if (isLabelPermissionDenial(error)) {
      return [LABEL_VISIBILITY_PROBLEM];
    }
    return [
      `GitHub API unreachable: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
};
