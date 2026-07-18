// Merge logic for the canonical settings file and its repo-owned extension.
// The seam may only add. Overriding a canonical repository key or redefining a
// canonical ruleset or label could weaken the canonical floor; GitHub layers
// multiple rulesets strictest-wins, so adding is always safe. The one
// subtractive declaration is the ruleset-enforcement opt-out, which skips the
// ruleset gate entirely rather than weakening any single rule.

import { labelIdentity } from './github-label-identity';
import {
  ENFORCEMENT_OPT_OUT,
  type GithubSettings,
  isLabelDeclaration,
  isNamedRuleset,
  type ParsedGithubSettings,
} from './github-settings-parse';

const completeSettings = (
  parsed: ParsedGithubSettings | null,
): GithubSettings | null => {
  if (
    parsed === null ||
    parsed.repository === null ||
    parsed.rulesets === null ||
    parsed.labels === null ||
    parsed.rulesetEnforcement === null
  ) {
    return null;
  }
  const rulesets = parsed.rulesets.filter(isNamedRuleset);
  const labels = parsed.labels.filter(isLabelDeclaration);
  if (
    rulesets.length !== parsed.rulesets.length ||
    labels.length !== parsed.labels.length
  ) {
    return null;
  }
  return {
    repository: parsed.repository,
    rulesets,
    labels,
    rulesetEnforcement: parsed.rulesetEnforcement,
  };
};

const enforcementMergeProblems = (
  local: ParsedGithubSettings | null,
): ReadonlyArray<string> => {
  if (
    local?.rulesetEnforcement !== ENFORCEMENT_OPT_OUT ||
    local.rulesets === null ||
    local.rulesets.length === 0
  ) {
    return [];
  }
  return [
    `.github/settings.local.json declares additional rulesets while "rulesetEnforcement" is "${ENFORCEMENT_OPT_OUT}"; remove the rulesets or the opt-out`,
  ];
};

const repositoryMergeProblems = (
  canonical: ParsedGithubSettings | null,
  local: ParsedGithubSettings | null,
): ReadonlyArray<string> => {
  if (
    canonical === null ||
    canonical.repository === null ||
    local === null ||
    local.repository === null
  ) {
    return [];
  }
  const canonicalRepository = canonical.repository;
  return Object.keys(local.repository)
    .filter((key) => key in canonicalRepository)
    .map(
      (key) =>
        `.github/settings.local.json repository."${key}" would override a canonical value; canonical settings are read-only`,
    );
};

const rulesetMergeProblems = (
  canonical: ParsedGithubSettings | null,
  local: ParsedGithubSettings | null,
): ReadonlyArray<string> => {
  if (
    canonical === null ||
    canonical.rulesets === null ||
    local === null ||
    local.rulesets === null
  ) {
    return [];
  }
  const canonicalNames = new Set(
    canonical.rulesets.filter(isNamedRuleset).map((ruleset) => ruleset.name),
  );
  return local.rulesets
    .filter(isNamedRuleset)
    .filter((ruleset) => canonicalNames.has(ruleset.name))
    .map(
      (ruleset) =>
        `.github/settings.local.json ruleset "${ruleset.name}" collides with a canonical ruleset; add a separately named ruleset to tighten further`,
    );
};

const labelMergeProblems = (
  canonical: ParsedGithubSettings | null,
  local: ParsedGithubSettings | null,
): ReadonlyArray<string> => {
  if (
    canonical === null ||
    canonical.labels === null ||
    local === null ||
    local.labels === null
  ) {
    return [];
  }
  const canonicalNames = new Set(
    canonical.labels
      .filter(isLabelDeclaration)
      .map((label) => labelIdentity(label.name)),
  );
  return local.labels
    .filter(isLabelDeclaration)
    .filter((label) => canonicalNames.has(labelIdentity(label.name)))
    .map(
      (label) =>
        `.github/settings.local.json label "${label.name}" collides with a canonical label; canonical labels are read-only`,
    );
};

export type MergedSettings = {
  readonly merged: GithubSettings | null;
  readonly problems: ReadonlyArray<string>;
};

export const mergeSettings = (
  canonical: ParsedGithubSettings | null,
  local: ParsedGithubSettings | null,
): MergedSettings => {
  const problems = [
    ...enforcementMergeProblems(local),
    ...repositoryMergeProblems(canonical, local),
    ...rulesetMergeProblems(canonical, local),
    ...labelMergeProblems(canonical, local),
  ];
  const completeCanonical = completeSettings(canonical);
  const completeLocal = completeSettings(local);
  if (
    problems.length > 0 ||
    completeCanonical === null ||
    completeLocal === null
  ) {
    return { merged: null, problems };
  }
  return {
    merged: {
      repository: {
        ...completeCanonical.repository,
        ...completeLocal.repository,
      },
      rulesets: [...completeCanonical.rulesets, ...completeLocal.rulesets],
      labels: [...completeCanonical.labels, ...completeLocal.labels],
      rulesetEnforcement: completeLocal.rulesetEnforcement,
    },
    problems: [],
  };
};
