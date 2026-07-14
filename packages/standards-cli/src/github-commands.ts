// Verifies live GitHub settings against the declaration and fails closed on drift or API error. `standards
// github --apply` converges the live repository; it needs an admin token, so
// it runs locally rather than in CI.

import {
  apiError,
  fetchLiveRulesets,
  HTTP_OK,
  loadDeclared,
  request,
  resolveGithubRepo,
  resolveToken,
} from './github-api';
import { applyRulesets } from './github-apply';
import {
  diffEnvironment,
  diffRepositorySettings,
  diffRulesets,
} from './github-diff';
import { applyEnvironment } from './github-environment-apply';
import { fetchLiveEnvironment } from './github-environments';
import { type GithubSettings, isRecord } from './github-settings';

const reportProblems = (problems: ReadonlyArray<string>): void => {
  console.error(
    `standards github: ${problems.length} problem(s) with declared GitHub settings:`,
  );
  console.error(problems.map((problem) => `  - ${problem}`).join('\n'));
};

const collectEnvironmentDrift = async (
  token: string | null,
  repo: string,
  environments: GithubSettings['environments'],
): Promise<ReadonlyArray<string>> => {
  const liveEnvironments = await Promise.all(
    environments.map(async (declared) => ({
      declared,
      live: await fetchLiveEnvironment(token, repo, String(declared.name)),
    })),
  );
  return liveEnvironments.flatMap(({ declared, live }) => {
    if (live.problem !== null) {
      return [live.problem];
    }
    if (live.missing || live.environment === null) {
      return [
        `environment "${declared.name}" is declared but missing on GitHub`,
      ];
    }
    return diffEnvironment(declared, live.environment);
  });
};

const applyEnvironments = async (
  token: string,
  repo: string,
  environments: GithubSettings['environments'],
  reportAction: (action: string) => void,
): Promise<void> => {
  for (const environment of environments) {
    // biome-ignore lint/performance/noAwaitInLoops: GitHub write requests are intentionally serialized to avoid secondary rate limits.
    await applyEnvironment(token, repo, environment, reportAction);
  }
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
  const problems: Array<string> = [];
  try {
    const repoResponse = await request(token, 'GET', `/repos/${repo}`);
    if (repoResponse.status !== HTTP_OK || !isRecord(repoResponse.body)) {
      problems.push(apiError(`reading repository ${repo}`, repoResponse));
    } else {
      const diff = diffRepositorySettings(
        declared.repository,
        repoResponse.body,
      );
      problems.push(...diff.drifted);
      if (diff.unverifiable.length > 0) {
        console.log(
          `standards github: repository setting(s) not visible to this token, verify with admin auth: ${diff.unverifiable.join(', ')}`,
        );
      }
    }
    const live = await fetchLiveRulesets(token, repo);
    if (live.rulesets === null) {
      problems.push(live.problem ?? 'unable to read rulesets');
    } else {
      const rulesetDiff = diffRulesets(declared.rulesets, live.rulesets);
      problems.push(...rulesetDiff.drifted);
      if (rulesetDiff.unverifiable.length > 0) {
        console.log(
          `standards github: ruleset field(s) not visible to this token, verify with admin auth: ${rulesetDiff.unverifiable.join('; ')}`,
        );
      }
    }
    problems.push(
      ...(await collectEnvironmentDrift(token, repo, declared.environments)),
    );
  } catch (error) {
    problems.push(
      `GitHub API unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return problems;
};

export const runGithubCheck = async (consumer: string): Promise<boolean> => {
  const declared = await loadDeclared(consumer);
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
    'standards github: live GitHub settings match the declared configuration',
  );
  return true;
};

export const runGithubApply = async (consumer: string): Promise<boolean> => {
  const declared = await loadDeclared(consumer);
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
    let actionCount = 0;
    const reportAction = (action: string): void => {
      actionCount += 1;
      console.log(`  ${action}`);
    };
    const repoResponse = await request(token, 'GET', `/repos/${repo}`);
    if (repoResponse.status !== HTTP_OK || !isRecord(repoResponse.body)) {
      throw new Error(apiError(`reading repository ${repo}`, repoResponse));
    }
    const diff = diffRepositorySettings(
      declared.merged.repository,
      repoResponse.body,
    );
    if (diff.drifted.length > 0 || diff.unverifiable.length > 0) {
      const patched = await request(
        token,
        'PATCH',
        `/repos/${repo}`,
        declared.merged.repository,
      );
      if (patched.status !== HTTP_OK) {
        throw new Error(apiError('updating repository settings', patched));
      }
      reportAction('updated repository merge settings');
    }
    await applyRulesets(token, repo, declared.merged, reportAction);
    await applyEnvironments(
      token,
      repo,
      declared.merged.environments,
      reportAction,
    );
    console.log(
      actionCount === 0
        ? 'standards github: already converged; no changes'
        : `standards github: apply complete for ${repo}`,
    );
    return true;
  } catch (error) {
    console.error(
      `standards github: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
};
