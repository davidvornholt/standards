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
import { decodeLiveRepositorySettings } from './github-repository-settings';
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
  readonly repositoryInvalidKeys: ReadonlySet<string>;
  readonly rulesets: LiveRulesets;
};

type GithubStateDiff = {
  readonly drifted: ReadonlyArray<string>;
  readonly unverifiable: ReadonlyArray<string>;
};

const diffDefaultBranch = (
  declared: GithubSettings['defaultBranchProtection'],
  live: LiveDefaultBranch | null,
): GithubStateDiff => {
  if (declared === null || live === null || live.problem !== null) {
    return { drifted: [], unverifiable: [] };
  }
  if (!live.classicProtection) {
    return {
      drifted: [
        `default branch "${live.branch}" has no classic branch protection`,
      ],
      unverifiable: [],
    };
  }
  if (live.unverifiable) {
    return {
      drifted: [],
      unverifiable: [`default branch "${live.branch}" protection details`],
    };
  }
  return live.protection === null || !subsetMatches(declared, live.protection)
    ? {
        drifted: [
          `default branch "${live.branch}" protection differs from the declaration`,
        ],
        unverifiable: [],
      }
    : { drifted: [], unverifiable: [] };
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
    const problem = apiError(`reading repository ${repo}`, repositoryResponse);
    return {
      defaultBranch: null,
      environments: [],
      problems: [problem],
      repository: {},
      repositoryInvalidKeys: new Set(Object.keys(declared.repository)),
      rulesets: {
        problem: 'rulesets were not read because repository identity failed',
        rulesets: null,
      },
    };
  }
  const repository = decodeLiveRepositorySettings(
    repositoryResponse.body,
    declared.repository,
    detailRequired,
  );
  const [defaultBranch, rulesets, environments] = await Promise.all([
    declared.defaultBranchProtection === null
      ? Promise.resolve(null)
      : fetchDefaultBranchProtection(
          token,
          repo,
          repositoryResponse.body,
          detailRequired,
        ),
    fetchLiveRulesets(token, repo, detailRequired),
    Promise.all(
      declared.environments.map(async (environment) => ({
        declared: environment,
        live: await fetchLiveEnvironment(token, repo, String(environment.name)),
      })),
    ),
  ]);
  const problems = [
    ...repository.problems,
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
    repository: repository.settings,
    repositoryInvalidKeys: repository.invalidKeys,
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
  const comparableRepositoryDeclaration = Object.fromEntries(
    Object.entries(declared.repository).filter(
      ([key]) => !live.repositoryInvalidKeys.has(key),
    ),
  );
  const repository = diffRepositorySettings(
    comparableRepositoryDeclaration,
    live.repository,
  );
  const rulesets =
    live.rulesets.rulesets === null
      ? { drifted: [], unverifiable: [] }
      : diffRulesets(declared.rulesets, live.rulesets.rulesets);
  const defaultBranch = diffDefaultBranch(
    declared.defaultBranchProtection,
    live.defaultBranch,
  );
  const drifted = [
    ...live.problems,
    ...repository.drifted,
    ...rulesets.drifted,
    ...defaultBranch.drifted,
  ];
  const unverifiable = [
    ...repository.unverifiable,
    ...rulesets.unverifiable,
    ...defaultBranch.unverifiable,
  ];
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
