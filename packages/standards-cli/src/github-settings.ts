// Merge canonical GitHub settings with the repo-owned extension. Parsing,
// drift, and API work live in named modules; this stays dependency-free.

import {
  ENFORCEMENT_OPT_OUT,
  type GithubSettings,
  isNamedRuleset,
  LOCAL_SETTINGS_KEYS,
  type ParsedGithubSettings,
  parseSettings,
  SETTINGS_KEYS,
} from './github-settings-parse';

export type LoadedGithubSettings = {
  readonly merged: GithubSettings | null;
  readonly problems: ReadonlyArray<string>;
};

const completeSettings = (
  parsed: ParsedGithubSettings | null,
): GithubSettings | null => {
  if (
    parsed === null ||
    parsed.repository === null ||
    parsed.rulesets === null ||
    parsed.rulesetEnforcement === null
  ) {
    return null;
  }
  const rulesets = parsed.rulesets.filter(isNamedRuleset);
  if (rulesets.length !== parsed.rulesets.length) {
    return null;
  }
  return {
    repository: parsed.repository,
    rulesets,
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

// The seam may only add. Overriding a canonical repository key or redefining a
// canonical ruleset could weaken the canonical floor; GitHub layers multiple
// rulesets strictest-wins, so adding a ruleset is always safe. The one
// subtractive declaration is the ruleset-enforcement opt-out, which skips the
// ruleset gate entirely rather than weakening any single rule.
const mergeSettings = (
  canonical: ParsedGithubSettings | null,
  local: ParsedGithubSettings | null,
) => {
  const problems = [
    ...enforcementMergeProblems(local),
    ...repositoryMergeProblems(canonical, local),
    ...rulesetMergeProblems(canonical, local),
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
      rulesetEnforcement: completeLocal.rulesetEnforcement,
    },
    problems: [],
  };
};

type JsonParse = {
  readonly value: unknown;
  readonly problem: string | null;
};

const parseJson = (raw: string, label: string): JsonParse => {
  try {
    return { value: JSON.parse(raw) as unknown, problem: null };
  } catch {
    return { value: null, problem: `${label} must contain valid JSON` };
  }
};

// Parse both files and merge them, gathering every problem before failing.
export const loadGithubSettings = (
  canonicalRaw: string,
  localRaw: string | null,
): LoadedGithubSettings => {
  const problems: Array<string> = [];
  const canonicalJson = parseJson(canonicalRaw, '.github/settings.json');
  if (canonicalJson.problem !== null) {
    problems.push(canonicalJson.problem);
  }
  if (localRaw === null) {
    problems.push(
      '.github/settings.local.json must exist; seed it with {"repository":{},"rulesets":[]}',
    );
  }
  const localJson =
    localRaw === null
      ? null
      : parseJson(localRaw, '.github/settings.local.json');
  if (localJson !== null && localJson.problem !== null) {
    problems.push(localJson.problem);
  }
  const canonical =
    canonicalJson.problem === null
      ? parseSettings(
          canonicalJson.value,
          '.github/settings.json',
          SETTINGS_KEYS,
        )
      : null;
  const local =
    localJson?.problem === null
      ? parseSettings(
          localJson.value,
          '.github/settings.local.json',
          LOCAL_SETTINGS_KEYS,
        )
      : null;
  if (canonical !== null) {
    problems.push(...canonical.problems);
  }
  if (local !== null) {
    problems.push(...local.problems);
  }
  const merged = mergeSettings(
    canonical?.settings ?? null,
    local?.settings ?? null,
  );
  problems.push(...merged.problems);
  return { merged: problems.length === 0 ? merged.merged : null, problems };
};
