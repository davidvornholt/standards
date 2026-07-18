// `standards github --check` verifies the live GitHub repository against the
// declared settings and fails closed on any drift, API error, or declared
// state the token cannot see. `standards github --apply` converges the live
// repository; it needs an admin token, so it runs locally rather than in CI.

import {
  apiError,
  fetchLiveRulesets,
  HTTP_OK,
  loadDeclared,
  request,
  resolveGithubRepo,
  resolveToken,
} from './github-api';
import {
  applyRepositorySettings,
  applyRulesets,
  applySummary,
} from './github-apply';
import {
  enforceableRepositorySettings,
  optOutEligibilityProblem,
  unverifiableProblem,
} from './github-command-shared';
import { diffRepositorySettings, diffRulesets } from './github-diff';
import { type GithubSettings, isRecord } from './github-settings-parse';

// Printed on every check and apply while the opt-out is declared: the skip
// must stay louder than the comfort of a green gate.
const UNENFORCEABLE_NOTICE =
  'standards github: rulesets are declared unenforceable on this GitHub plan (.github/settings.local.json "rulesetEnforcement"); the default branch is NOT protected, and plan-gated repository settings ("allow_auto_merge") are skipped. After upgrading the plan, remove the declaration, then run `bun standards github --apply`.';

const reportProblems = (problems: ReadonlyArray<string>): void => {
  console.error(
    `standards github: ${problems.length} problem(s) with declared GitHub settings:`,
  );
  console.error(problems.map((problem) => `  - ${problem}`).join('\n'));
};

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
  const diff = diffRepositorySettings(
    enforceableRepositorySettings(declared),
    repoResponse.body,
  );
  return [
    ...diff.drifted,
    ...unverifiableProblem('repository setting(s)', diff.unverifiable),
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

const collectLiveDrift = async (
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

export const runGithubCheck = async (consumer: string): Promise<boolean> => {
  const declared = await loadDeclared(consumer);
  if (declared.merged?.rulesetEnforcement === 'unavailable-on-plan') {
    console.log(UNENFORCEABLE_NOTICE);
  }
  const problems = [...declared.problems];
  if (declared.merged !== null) {
    problems.push(...(await collectLiveDrift(consumer, declared.merged)));
  }
  if (problems.length > 0) {
    reportProblems(problems);
    console.error(
      'Converge with `bun standards github --apply` (admin auth), or fix the declaration.',
    );
    return false;
  }
  console.log(
    declared.merged?.rulesetEnforcement === 'unavailable-on-plan'
      ? 'standards github: live repository settings match the declared configuration (plan-gated settings skipped)'
      : 'standards github: live GitHub settings match the declared configuration',
  );
  return true;
};

export const runGithubApply = async (consumer: string): Promise<boolean> => {
  const declared = await loadDeclared(consumer);
  if (declared.merged?.rulesetEnforcement === 'unavailable-on-plan') {
    console.log(UNENFORCEABLE_NOTICE);
  }
  if (declared.merged === null || declared.problems.length > 0) {
    reportProblems(declared.problems);
    return false;
  }
  const repo = resolveGithubRepo(consumer);
  if (repo === null) {
    console.error(
      'standards github: cannot determine the GitHub repository from the origin remote',
    );
    return false;
  }
  const token = resolveToken();
  if (token === null) {
    console.error(
      'standards github: apply needs an admin token; authenticate the gh CLI or set GH_TOKEN',
    );
    return false;
  }
  try {
    const repoResponse = await request(token, 'GET', `/repos/${repo}`);
    if (repoResponse.status !== HTTP_OK || !isRecord(repoResponse.body)) {
      throw new Error(apiError(`reading repository ${repo}`, repoResponse));
    }
    const eligibilityProblem = optOutEligibilityProblem(
      repo,
      declared.merged,
      repoResponse.body,
    );
    if (eligibilityProblem !== null) {
      throw new Error(eligibilityProblem);
    }
    const actions = [
      ...(await applyRepositorySettings(
        token,
        repo,
        enforceableRepositorySettings(declared.merged),
        repoResponse.body,
      )),
    ];
    const rulesetsSkipped =
      declared.merged.rulesetEnforcement === 'unavailable-on-plan';
    if (!rulesetsSkipped) {
      actions.push(...(await applyRulesets(token, repo, declared.merged)));
    }
    for (const action of actions) {
      console.log(`  ${action}`);
    }
    console.log(applySummary(repo, actions, rulesetsSkipped));
    return true;
  } catch (error) {
    console.error(
      `standards github: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
};
