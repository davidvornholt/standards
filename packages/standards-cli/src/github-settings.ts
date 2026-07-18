// Load and merge canonical GitHub settings with the repo-owned extension.
// Parsing lives in github-settings-parse.ts, merge policy in
// github-settings-merge.ts, drift in github-diff.ts, and API work in
// github-api.ts; this stays dependency-free.

import { mergeSettings } from './github-settings-merge';
import {
  type GithubSettings,
  LOCAL_SETTINGS_KEYS,
  parseSettings,
  SETTINGS_KEYS,
} from './github-settings-parse';

export type LoadedGithubSettings = {
  readonly merged: GithubSettings | null;
  readonly problems: ReadonlyArray<string>;
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
