import { apiError, HTTP_OK, request } from './github-api';
import {
  fetchDefaultBranchProtection,
  type LiveDefaultBranch,
} from './github-default-branch';
import {
  fetchLiveEnvironment,
  type LiveEnvironment,
} from './github-environments';
import {
  fetchImmutableReleases,
  type LiveImmutableReleases,
} from './github-immutable-releases';
import { decodeLiveRepositorySettings } from './github-repository-settings';
import { fetchLiveRulesets, type LiveRulesets } from './github-rulesets';
import { type GithubSettings, isRecord } from './github-settings-value';

export type EnvironmentSnapshot = {
  readonly declared: Readonly<Record<string, unknown>>;
  readonly live: LiveEnvironment;
};

export type GithubLiveState = {
  readonly defaultBranch: LiveDefaultBranch | null;
  readonly environments: ReadonlyArray<EnvironmentSnapshot>;
  readonly immutableReleases: LiveImmutableReleases | null;
  readonly problems: ReadonlyArray<string>;
  readonly repository: Readonly<Record<string, unknown>>;
  readonly repositoryInvalidKeys: ReadonlySet<string>;
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
    const problem = apiError(`reading repository ${repo}`, repositoryResponse);
    return {
      defaultBranch: null,
      environments: [],
      immutableReleases: null,
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
  const [defaultBranch, immutableReleases, rulesets, environments] =
    await Promise.all([
      declared.defaultBranchProtection === null
        ? Promise.resolve(null)
        : fetchDefaultBranchProtection(
            token,
            repo,
            repositoryResponse.body,
            detailRequired,
          ),
      declared.immutableReleases === null
        ? Promise.resolve(null)
        : fetchImmutableReleases(token, repo, detailRequired),
      fetchLiveRulesets(token, repo, detailRequired),
      Promise.all(
        declared.environments.map(async (environment) => ({
          declared: environment,
          live: await fetchLiveEnvironment(
            token,
            repo,
            String(environment.name),
          ),
        })),
      ),
    ]);
  const problems = [
    ...repository.problems,
    ...(defaultBranch?.problem === null || defaultBranch === null
      ? []
      : [defaultBranch.problem]),
    ...(immutableReleases?.problem === null || immutableReleases === null
      ? []
      : [immutableReleases.problem]),
    ...(rulesets.problem === null ? [] : [rulesets.problem]),
    ...environments.flatMap(({ live }) =>
      live.problem === null ? [] : [live.problem],
    ),
  ];
  return {
    defaultBranch,
    environments,
    immutableReleases,
    problems,
    repository: repository.settings,
    repositoryInvalidKeys: repository.invalidKeys,
    rulesets,
  };
};
