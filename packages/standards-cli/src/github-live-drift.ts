// Drift collection for `standards github --check`: compares the live GitHub
// repository against the merged declaration and fails closed on state the
// token cannot see. Command wiring lives in github-commands.ts.

import {
  apiError,
  fetchLiveRulesets,
  fetchMergeSettingsViaGraphql,
  HTTP_OK,
  request,
  resolveGithubRepo,
  resolveToken,
} from './github-api';
import {
  enforceableRepositorySettings,
  optOutEligibilityProblem,
  unverifiableProblem,
} from './github-command-shared';
import { diffRepositorySettings, diffRulesets } from './github-diff';
import { type GithubSettings, isRecord } from './github-settings-parse';

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
    ...unverifiableProblem('repository setting(s)', rediff.unverifiable),
  ];
};

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
  return [
    ...diff.drifted,
    ...unverifiableProblem('ruleset field(s)', diff.unverifiable),
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
    return [
      ...(await repositoryDrift(token, repo, declared)),
      ...(await rulesetDrift(token, repo, declared)),
    ];
  } catch (error) {
    return [
      `GitHub API unreachable: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
};
