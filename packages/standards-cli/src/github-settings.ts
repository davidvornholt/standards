// Parse and merge the canonical GitHub declaration with its additive local
// seam. This stays dependency-free because the published CLI imports it.

import { defaultBranchProtectionProblems } from './github-default-branch-settings';
import { environmentListProblems } from './github-environment-settings';
import { mergeGithubSettings } from './github-settings-merge';

export type GithubSettings = {
  readonly defaultBranchProtection: Readonly<Record<string, unknown>> | null;
  readonly repository: Readonly<Record<string, unknown>>;
  readonly rulesets: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly environments: ReadonlyArray<Readonly<Record<string, unknown>>>;
};

export type LoadedGithubSettings = {
  readonly merged: GithubSettings | null;
  readonly problems: ReadonlyArray<string>;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const SETTINGS_KEYS = new Set([
  'default_branch_protection',
  'repository',
  'rulesets',
  'environments',
]);

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
  const defaultBranchProtection = raw.default_branch_protection ?? null;
  if (defaultBranchProtection !== null) {
    problems.push(
      ...defaultBranchProtectionProblems(
        defaultBranchProtection,
        `${label} default_branch_protection`,
      ),
    );
  }
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
  const environments = raw.environments ?? [];
  if (Array.isArray(environments)) {
    problems.push(...environmentListProblems(environments, label));
  } else {
    problems.push(`${label} "environments" must be an array`);
  }
  if (problems.length > 0) {
    return { settings: null, problems };
  }
  return {
    settings: {
      defaultBranchProtection: defaultBranchProtection as Record<
        string,
        unknown
      > | null,
      repository: repository as Record<string, unknown>,
      rulesets: rulesets as ReadonlyArray<Record<string, unknown>>,
      environments: environments as ReadonlyArray<Record<string, unknown>>,
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
      '.github/settings.local.json must exist; seed it with {"repository":{},"rulesets":[],"environments":[]}',
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
  const merged = mergeGithubSettings(canonical.settings, local.settings);
  return { merged: merged.merged, problems: [...problems, ...merged.problems] };
};
