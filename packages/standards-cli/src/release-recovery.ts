const STABLE_SEMVER =
  /^(?<major>0|[1-9][0-9]*)\.(?<minor>0|[1-9][0-9]*)\.(?<patch>0|[1-9][0-9]*)$/u;

export type NpmReleasePlan =
  | { readonly action: 'publish' | 'recover'; readonly problem: null }
  | { readonly action: null; readonly problem: string };

export type GithubReleaseState = 'draft' | 'missing' | 'published' | 'tag-only';

export type ReconciliationPlan =
  | { readonly action: 'create' | 'none'; readonly problem: null }
  | { readonly action: null; readonly problem: string };

const stableSemverParts = (version: string): ReadonlyArray<number> | null => {
  const match = STABLE_SEMVER.exec(version);
  if (match === null) {
    return null;
  }
  const { major, minor, patch } = match.groups ?? {};
  if (major === undefined || minor === undefined || patch === undefined) {
    return null;
  }
  const parts = [major, minor, patch].map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
};

const compareStableSemver = (left: string, right: string) => {
  const leftParts = stableSemverParts(left);
  const rightParts = stableSemverParts(right);
  if (leftParts === null || rightParts === null) {
    return null;
  }
  for (const [index, part] of leftParts.entries()) {
    const difference = part - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

export const npmReleasePlan = (
  version: string,
  latest: string,
  exactVersionExists: boolean,
): NpmReleasePlan => {
  const order = compareStableSemver(version, latest);
  if (order === null) {
    return {
      action: null,
      problem: `Manifest and npm latest versions must be stable SemVer values; received ${version} and ${latest}`,
    };
  }
  if (exactVersionExists) {
    return { action: 'recover', problem: null };
  }
  if (order < 0) {
    return {
      action: null,
      problem: `Manifest version ${version} is behind npm latest ${latest}`,
    };
  }
  return { action: 'publish', problem: null };
};

export const githubReconciliationPlan = (
  state: GithubReleaseState,
  tagSha: string | null,
  expectedSha: string,
): ReconciliationPlan => {
  if (state === 'draft') {
    return {
      action: null,
      problem: 'Release already exists as a draft',
    };
  }
  if (state === 'missing') {
    return { action: 'create', problem: null };
  }
  if (tagSha !== expectedSha) {
    return {
      action: null,
      problem: `Release tag points to ${tagSha ?? 'no commit'}, expected ${expectedSha}`,
    };
  }
  return {
    action: state === 'published' ? 'none' : 'create',
    problem: null,
  };
};
