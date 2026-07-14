import { environmentIdentity } from './github-environment-settings';
import type { GithubSettings } from './github-settings';

type MergeResult = {
  readonly merged: GithubSettings | null;
  readonly problems: ReadonlyArray<string>;
};

export const mergeGithubSettings = (
  canonical: GithubSettings,
  local: GithubSettings,
): MergeResult => {
  const problems: Array<string> = [];
  if (local.defaultBranchProtection !== null) {
    problems.push(
      '.github/settings.local.json default_branch_protection cannot override the canonical default-branch owner; add a local ruleset to tighten policy',
    );
  }
  for (const key of Object.keys(local.repository)) {
    if (key in canonical.repository) {
      problems.push(
        `.github/settings.local.json repository."${key}" would override a canonical value; canonical settings are read-only`,
      );
    }
  }
  const canonicalNames = new Set(
    canonical.rulesets.map((ruleset) => ruleset.name),
  );
  for (const ruleset of local.rulesets) {
    if (canonicalNames.has(ruleset.name)) {
      problems.push(
        `.github/settings.local.json ruleset "${ruleset.name}" collides with a canonical ruleset; add a separately named ruleset to tighten further`,
      );
    }
  }
  const canonicalEnvironmentNames = new Set(
    canonical.environments.map((environment) =>
      environmentIdentity(String(environment.name)),
    ),
  );
  for (const environment of local.environments) {
    if (
      canonicalEnvironmentNames.has(
        environmentIdentity(String(environment.name)),
      )
    ) {
      problems.push(
        `.github/settings.local.json environment "${environment.name}" collides with a canonical environment; canonical settings are read-only`,
      );
    }
  }
  return problems.length > 0
    ? { merged: null, problems }
    : {
        merged: {
          defaultBranchProtection: canonical.defaultBranchProtection,
          environments: [...canonical.environments, ...local.environments],
          repository: { ...canonical.repository, ...local.repository },
          rulesets: [...canonical.rulesets, ...local.rulesets],
        },
        problems: [],
      };
};
