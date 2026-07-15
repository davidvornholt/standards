// Parse and merge the canonical GitHub declaration with its additive local
// seam. This stays dependency-free because the published CLI imports it.

import { defaultBranchProtectionProblems } from './github-default-branch-settings';
import { environmentListProblems } from './github-environment-settings';
import {
  repositorySettingValueProblem,
  SUPPORTED_REPOSITORY_SETTING_KEYS,
} from './github-repository-settings';
import { rulesetListProblems } from './github-ruleset-settings';
import { mergeGithubSettings } from './github-settings-merge';
import { type GithubSettings, isRecord } from './github-settings-value';

export type LoadedGithubSettings = {
  readonly merged: GithubSettings | null;
  readonly problems: ReadonlyArray<string>;
};

const SETTINGS_KEYS = new Set([
  'default_branch_protection',
  'repository',
  'rulesets',
  'environments',
]);
const REPOSITORY_IDENTITY_KEYS = new Set([
  'archived',
  'default_branch',
  'is_template',
  'name',
  'private',
  'visibility',
]);
const REPOSITORY_SETTING_KEYS = new Set<string>(
  SUPPORTED_REPOSITORY_SETTING_KEYS,
);
type ParseResult = {
  readonly settings: GithubSettings | null;
  readonly problems: ReadonlyArray<string>;
};

const repositoryProblems = (
  repository: unknown,
  label: string,
): ReadonlyArray<string> => {
  if (!isRecord(repository)) {
    return [`${label} "repository" must be an object`];
  }
  return Object.entries(repository).flatMap(([key, value]) => {
    if (REPOSITORY_IDENTITY_KEYS.has(key)) {
      return [
        `${label} repository."${key}" cannot manage repository identity or lifecycle`,
      ];
    }
    if (!REPOSITORY_SETTING_KEYS.has(key)) {
      return [`${label} repository has unknown key "${key}"`];
    }
    const problem = repositorySettingValueProblem(
      key,
      value,
      `${label} repository`,
    );
    return problem === null ? [] : [problem];
  });
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
  problems.push(...repositoryProblems(repository, label));
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
