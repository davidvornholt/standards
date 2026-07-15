import type { LiveDefaultBranch } from './github-default-branch';
import {
  diffEnvironment,
  diffRepositorySettings,
  diffRulesets,
  subsetMatches,
} from './github-diff';
import { diffImmutableReleases } from './github-immutable-releases';
import type { GithubLiveState } from './github-live-state';
import type { GithubSettings } from './github-settings-value';

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

const environmentDrift = (live: GithubLiveState): ReadonlyArray<string> =>
  live.environments.flatMap(
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
  );

export const diffGithubLiveState = (
  declared: GithubSettings,
  live: GithubLiveState,
): GithubStateDiff => {
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
  const immutableReleases = diffImmutableReleases(
    declared.immutableReleases,
    live.immutableReleases,
  );
  return {
    drifted: [
      ...live.problems,
      ...repository.drifted,
      ...rulesets.drifted,
      ...defaultBranch.drifted,
      ...immutableReleases.drifted,
      ...environmentDrift(live),
    ],
    unverifiable: [
      ...repository.unverifiable,
      ...rulesets.unverifiable,
      ...defaultBranch.unverifiable,
      ...immutableReleases.unverifiable,
    ],
  };
};
