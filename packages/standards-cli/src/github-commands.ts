import {
  apiError,
  HTTP_OK,
  loadDeclared,
  request,
  resolveGithubRepo,
  resolveToken,
} from './github-api';
import { applyPrefetchedRulesets } from './github-apply';
import { applyDefaultBranchProtection } from './github-default-branch-apply';
import { diffRepositorySettings } from './github-diff';
import { applyPrefetchedEnvironment } from './github-environment-apply';
import { diffGithubLiveState, readGithubLiveState } from './github-live-state';

const reportProblems = (problems: ReadonlyArray<string>): void => {
  console.error(
    `standards github: ${problems.length} problem(s) with declared GitHub settings:`,
  );
  console.error(problems.map((problem) => `  - ${problem}`).join('\n'));
};

export const runGithubCheck = async (consumer: string): Promise<boolean> => {
  const declared = await loadDeclared(consumer);
  const problems = [...declared.problems];
  try {
    if (declared.merged !== null) {
      const repo = resolveGithubRepo(consumer);
      if (repo === null) {
        problems.push(
          'cannot determine the GitHub repository from the origin remote',
        );
      } else {
        const live = await readGithubLiveState(
          resolveToken(),
          repo,
          declared.merged,
          false,
        );
        const diff = diffGithubLiveState(declared.merged, live);
        problems.push(...diff.drifted);
        if (diff.unverifiable.length > 0) {
          console.log(
            `standards github: setting(s) not visible to this token, verify with admin auth: ${diff.unverifiable.join('; ')}`,
          );
        }
      }
    }
  } catch (error) {
    problems.push(
      `GitHub API unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
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
  if (declared.merged === null) {
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
    const live = await readGithubLiveState(token, repo, declared.merged, true);
    if (live.problems.length > 0) {
      throw new Error(live.problems.join('; '));
    }
    let actionCount = 0;
    const reportAction = (action: string): void => {
      actionCount += 1;
      console.log(`  ${action}`);
    };
    const repositoryDiff = diffRepositorySettings(
      declared.merged.repository,
      live.repository,
    );
    if (
      repositoryDiff.drifted.length > 0 ||
      repositoryDiff.unverifiable.length > 0
    ) {
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
    if (
      declared.merged.defaultBranchProtection !== null &&
      live.defaultBranch !== null
    ) {
      await applyDefaultBranchProtection({
        declared: declared.merged.defaultBranchProtection,
        live: live.defaultBranch,
        reportAction,
        repo,
        token,
      });
    }
    for (const environment of live.environments) {
      // biome-ignore lint/performance/noAwaitInLoops: GitHub writes are intentionally serialized to preserve migration ordering and avoid secondary rate limits.
      await applyPrefetchedEnvironment({
        declared: environment.declared,
        live: environment.live,
        reportAction,
        repo,
        token,
      });
    }
    await applyPrefetchedRulesets({
      declared: declared.merged,
      live: live.rulesets,
      reportAction,
      repo,
      token,
    });
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
