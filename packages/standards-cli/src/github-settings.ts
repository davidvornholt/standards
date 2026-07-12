// Declarative GitHub repository settings: parsing and seam merging for the
// canonical `.github/settings.json` and the repo-owned
// `.github/settings.local.json` extension. Pure logic only; drift comparison
// lives in github-diff.ts and the API interaction in github-api.ts. Like
// cli.ts, this module is zero-dependency so `bunx` can execute the published
// package.

export type GithubSettings = {
  readonly repository: Readonly<Record<string, unknown>>;
  readonly rulesets: ReadonlyArray<Readonly<Record<string, unknown>>>;
};

export type LoadedGithubSettings = {
  readonly merged: GithubSettings | null;
  readonly problems: ReadonlyArray<string>;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const SETTINGS_KEYS = new Set(['repository', 'rulesets']);

type ParseResult = {
  readonly settings: GithubSettings | null;
  readonly problems: ReadonlyArray<string>;
};

const rulesetListProblems = (
  rulesets: ReadonlyArray<unknown>,
  label: string,
): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const names = new Set<string>();
  for (const [index, ruleset] of rulesets.entries()) {
    if (
      !(
        isRecord(ruleset) &&
        typeof ruleset.name === 'string' &&
        ruleset.name.length > 0
      )
    ) {
      problems.push(
        `${label} rulesets[${index}] must be an object with a non-empty "name"`,
      );
    } else if (names.has(ruleset.name)) {
      problems.push(
        `${label} declares ruleset "${ruleset.name}" more than once`,
      );
    } else {
      names.add(ruleset.name);
    }
  }
  return problems;
};

const parseSettings = (raw: unknown, label: string): ParseResult => {
  if (!isRecord(raw)) {
    return { settings: null, problems: [`${label} must be a JSON object`] };
  }
  const problems: Array<string> = [];
  for (const key of Object.keys(raw)) {
    if (!SETTINGS_KEYS.has(key)) {
      problems.push(`${label} has unknown key "${key}"`);
    }
  }
  const repository = raw.repository ?? {};
  if (!isRecord(repository)) {
    problems.push(`${label} "repository" must be an object`);
  }
  const rulesets = raw.rulesets ?? [];
  if (Array.isArray(rulesets)) {
    problems.push(...rulesetListProblems(rulesets, label));
  } else {
    problems.push(`${label} "rulesets" must be an array`);
  }
  if (problems.length > 0) {
    return { settings: null, problems };
  }
  return {
    settings: {
      repository: repository as Record<string, unknown>,
      rulesets: rulesets as ReadonlyArray<Record<string, unknown>>,
    },
    problems: [],
  };
};

type MergeResult = {
  readonly merged: GithubSettings | null;
  readonly problems: ReadonlyArray<string>;
};

// The seam may only add. Overriding a canonical repository key or redefining a
// canonical ruleset could weaken the canonical floor; GitHub layers multiple
// rulesets strictest-wins, so adding a ruleset is always safe.
const mergeSettings = (
  canonical: GithubSettings,
  local: GithubSettings,
): MergeResult => {
  const problems: Array<string> = [];
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
  const canonical = parseSettings(canonicalJson.value, '.github/settings.json');
  const local = parseSettings(localJson?.value, '.github/settings.local.json');
  problems.push(...canonical.problems, ...local.problems);
  if (canonical.settings === null || local.settings === null) {
    return { merged: null, problems };
  }
  const merged = mergeSettings(canonical.settings, local.settings);
  return { merged: merged.merged, problems: [...problems, ...merged.problems] };
};
