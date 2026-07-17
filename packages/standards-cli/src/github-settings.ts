// Seam merging for the declarative GitHub repository settings: combines the
// canonical `.github/settings.json` with the repo-owned
// `.github/settings.local.json` extension. Per-file shape parsing lives in
// github-settings-parse.ts, drift comparison in github-diff.ts, and the API
// interaction in github-api.ts. Like cli.ts, this module is zero-dependency so
// `bunx` can execute the published package.

import {
  ENFORCEMENT_OPT_OUT,
  type GithubSettings,
  LOCAL_SETTINGS_KEYS,
  parseSettings,
  SETTINGS_KEYS,
} from './github-settings-parse';

export type LoadedGithubSettings = {
  readonly merged: GithubSettings | null;
  readonly problems: ReadonlyArray<string>;
};

type MergeResult = {
  readonly merged: GithubSettings | null;
  readonly problems: ReadonlyArray<string>;
};

// The seam may only add. Overriding a canonical repository key or redefining a
// canonical ruleset could weaken the canonical floor; GitHub layers multiple
// rulesets strictest-wins, so adding a ruleset is always safe. The one
// subtractive declaration is the ruleset-enforcement opt-out, which skips the
// ruleset gate entirely rather than weakening any single rule.
const mergeSettings = (
  canonical: GithubSettings,
  local: GithubSettings,
): MergeResult => {
  const problems: Array<string> = [];
  if (
    local.rulesetEnforcement === ENFORCEMENT_OPT_OUT &&
    local.rulesets.length > 0
  ) {
    problems.push(
      `.github/settings.local.json declares additional rulesets while "rulesetEnforcement" is "${ENFORCEMENT_OPT_OUT}"; remove the rulesets or the opt-out`,
    );
  }
  for (const key of Object.keys(local.repository)) {
    if (key in canonical.repository) {
      problems.push(
        `.github/settings.local.json repository."${key}" would override a canonical value; canonical settings are read-only`,
      );
    }
  }
  const canonicalNames = new Set(canonical.rulesets.map((r) => r.name));
  for (const ruleset of local.rulesets) {
    if (canonicalNames.has(ruleset.name)) {
      problems.push(
        `.github/settings.local.json ruleset "${ruleset.name}" collides with a canonical ruleset; add a separately named ruleset to tighten further`,
      );
    }
  }
  if (problems.length > 0) {
    return { merged: null, problems };
  }
  return {
    merged: {
      repository: { ...canonical.repository, ...local.repository },
      rulesets: [...canonical.rulesets, ...local.rulesets],
      rulesetEnforcement: local.rulesetEnforcement,
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
  if (problems.length > 0) {
    return { merged: null, problems };
  }
  const canonical = parseSettings(
    canonicalJson.value,
    '.github/settings.json',
    SETTINGS_KEYS,
  );
  const local = parseSettings(
    localJson?.value,
    '.github/settings.local.json',
    LOCAL_SETTINGS_KEYS,
  );
  problems.push(...canonical.problems, ...local.problems);
  if (canonical.settings === null || local.settings === null) {
    return { merged: null, problems };
  }
  const merged = mergeSettings(canonical.settings, local.settings);
  return { merged: merged.merged, problems: [...problems, ...merged.problems] };
};
