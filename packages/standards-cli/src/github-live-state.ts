import { apiError, HTTP_OK, request } from './github-api';
import {
  fetchDefaultBranchProtection,
  type LiveDefaultBranch,
} from './github-default-branch';
import {
  diffEnvironment,
  diffRepositorySettings,
  diffRulesets,
  subsetMatches,
} from './github-diff';
import {
  fetchLiveEnvironment,
  type LiveEnvironment,
} from './github-environments';
import { fetchLiveRulesets, type LiveRulesets } from './github-rulesets';
import { type GithubSettings, isRecord } from './github-settings';

export type EnvironmentSnapshot = {
  readonly declared: Readonly<Record<string, unknown>>;
  readonly live: LiveEnvironment;
};

export type GithubLiveState = {
  readonly defaultBranch: LiveDefaultBranch | null;
  readonly environments: ReadonlyArray<EnvironmentSnapshot>;
  readonly problems: ReadonlyArray<string>;
  readonly repository: Readonly<Record<string, unknown>>;
  readonly rulesets: LiveRulesets;
};

export const readGithubLiveState = async (
  token: string | null,
  repo: string,
  declared: GithubSettings,
  detailRequired: boolean,
): Promise<GithubLiveState> => {
  const repositoryResponse = await request(token, 'GET', `/repos/${repo}`);
  if (
    repositoryResponse.status !== HTTP_OK ||
    !isRecord(repositoryResponse.body)
  ) {
    return {
      defaultBranch: null,
      environments: [],
      problems: [apiError(`reading repository ${repo}`, repositoryResponse)],
      repository: {},
      rulesets: {
        problem: 'rulesets were not read because repository identity failed',
        rulesets: null,
      },
    };
  }
  const [defaultBranch, rulesets, environments] = await Promise.all([
    declared.defaultBranchProtection === null
      ? Promise.resolve(null)
      : fetchDefaultBranchProtection(
          token,
          repo,
          repositoryResponse.body,
          detailRequired,
        ),
    fetchLiveRulesets(token, repo),
    Promise.all(
      declared.environments.map(async (environment) => ({
        declared: environment,
        live: await fetchLiveEnvironment(token, repo, String(environment.name)),
      })),
    ),
  ]);
  const problems = [
    ...(defaultBranch?.problem === null || defaultBranch === null
      ? []
      : [defaultBranch.problem]),
    ...(rulesets.problem === null ? [] : [rulesets.problem]),
    ...environments.flatMap(({ live }) =>
      live.problem === null ? [] : [live.problem],
    ),
  ];
  return {
    defaultBranch,
    environments,
    problems,
    repository: repositoryResponse.body,
    rulesets,
  };
};

export const diffGithubLiveState = (
  declared: GithubSettings,
  live: GithubLiveState,
): {
  readonly drifted: ReadonlyArray<string>;
  readonly unverifiable: ReadonlyArray<string>;
} => {
  const repository = diffRepositorySettings(
    declared.repository,
    live.repository,
  );
  const rulesets =
    live.rulesets.rulesets === null
      ? { drifted: [], unverifiable: [] }
      : diffRulesets(declared.rulesets, live.rulesets.rulesets);
  const drifted = [
    ...live.problems,
    ...repository.drifted,
    ...rulesets.drifted,
  ];
  const unverifiable = [...repository.unverifiable, ...rulesets.unverifiable];
  if (
    declared.defaultBranchProtection !== null &&
    live.defaultBranch !== null
  ) {
    if (!live.defaultBranch.classicProtection) {
      drifted.push(
        `default branch "${live.defaultBranch.branch}" has no classic branch protection`,
      );
    } else if (live.defaultBranch.unverifiable) {
      unverifiable.push(
        `default branch "${live.defaultBranch.branch}" protection details`,
      );
    } else if (
      live.defaultBranch.protection === null ||
      !subsetMatches(
        declared.defaultBranchProtection,
        live.defaultBranch.protection,
      )
    ) {
      drifted.push(
        `default branch "${live.defaultBranch.branch}" protection differs from the declaration`,
      );
    }
  }
  drifted.push(
    ...live.environments.flatMap(
      ({ declared: environment, live: liveEnvironment }) => {
        if (liveEnvironment.problem !== null) {
          return [];
        }
        if (liveEnvironment.missing || liveEnvironment.environment === null) {
          return [
            `environment "${environment.name}" is declared but missing on GitHub`,
          ];
        }
        return diffEnvironment(environment, liveEnvironment.environment);
      },
    ),
  );
  return { drifted, unverifiable };
};
