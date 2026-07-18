// Host-level poller configuration. The poller is host infrastructure, not
// repository state: one config file on the polling host lists every watched
// repository, and all workflow state lives in GitHub labels and comments so
// ticks are stateless and safe to re-run.

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { isNonEmptyString, isRecord } from './github-settings-parse';

const REPO_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/u;

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'repos',
  'model',
  'reasoningEffort',
  // biome-ignore lint/security/noSecrets: a config key name, not a credential.
  'maxJobsPerTick',
  'staleClaimHours',
  'runTimeoutMinutes',
  'cacheDir',
  'extraCodexArgs',
]);

const DEFAULT_MAX_JOBS_PER_TICK = 1;
const DEFAULT_STALE_CLAIM_HOURS = 6;
// Thorough review runs legitimately take hours; the timeout exists to catch
// wedged agents, not to bound honest work.
const DEFAULT_RUN_TIMEOUT_MINUTES = 240;
const MINUTES_PER_HOUR = 60;

export type PollerConfig = {
  readonly repos: ReadonlyArray<string>;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly maxJobsPerTick: number;
  readonly staleClaimHours: number;
  readonly runTimeoutMinutes: number;
  readonly cacheDir: string;
  readonly extraCodexArgs: ReadonlyArray<string>;
};

export type PollerConfigResult = {
  readonly config: PollerConfig | null;
  readonly problems: ReadonlyArray<string>;
};

const expandHome = (path: string): string =>
  path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;

const parseRepos = (
  raw: unknown,
  problems: Array<string>,
): ReadonlyArray<string> => {
  if (!(Array.isArray(raw) && raw.every((repo) => typeof repo === 'string'))) {
    problems.push('poller config "repos" must be a string array');
    return [];
  }
  if (raw.length === 0) {
    problems.push('poller config "repos" must list at least one repository');
  }
  for (const repo of raw) {
    if (!REPO_PATTERN.test(repo)) {
      problems.push(
        `poller config "repos" entries must be "owner/repo": ${repo}`,
      );
    }
  }
  if (new Set(raw).size !== raw.length) {
    problems.push('poller config "repos" entries must be unique');
  }
  return raw;
};

const parsePositiveInteger = (
  raw: unknown,
  field: string,
  fallback: number,
  problems: Array<string>,
): number => {
  if (raw === undefined) {
    return fallback;
  }
  if (!(typeof raw === 'number' && Number.isInteger(raw) && raw > 0)) {
    problems.push(`poller config "${field}" must be a positive integer`);
    return fallback;
  }
  return raw;
};

const parseRequiredString = (
  raw: unknown,
  field: string,
  problems: Array<string>,
): string => {
  if (!isNonEmptyString(raw)) {
    problems.push(
      `poller config "${field}" must be a non-empty string; the model choice is deliberate and has no default`,
    );
    return '';
  }
  return raw;
};

const parseExtraCodexArgs = (
  raw: unknown,
  problems: Array<string>,
): ReadonlyArray<string> => {
  if (raw === undefined) {
    return [];
  }
  if (!(Array.isArray(raw) && raw.every((arg) => typeof arg === 'string'))) {
    problems.push('poller config "extraCodexArgs" must be a string array');
    return [];
  }
  return raw;
};

const parseCacheDir = (
  raw: unknown,
  configDir: string,
  problems: Array<string>,
): string => {
  if (raw === undefined) {
    return join(homedir(), '.cache', 'standards-poller');
  }
  if (!isNonEmptyString(raw)) {
    problems.push('poller config "cacheDir" must be a non-empty string');
    return join(homedir(), '.cache', 'standards-poller');
  }
  const expanded = expandHome(raw);
  return isAbsolute(expanded) ? expanded : resolve(configDir, expanded);
};

// Reject unknown keys so a typo fails loudly instead of silently using a
// default, mirroring the sync policy and settings parsers.
export const parsePollerConfig = (
  raw: unknown,
  configDir: string,
): PollerConfigResult => {
  if (!isRecord(raw)) {
    return { config: null, problems: ['poller config must be a JSON object'] };
  }
  const problems: Array<string> = [];
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) {
      problems.push(`poller config has unknown key "${key}"`);
    }
  }
  const config: PollerConfig = {
    repos: parseRepos(raw.repos, problems),
    model: parseRequiredString(raw.model, 'model', problems),
    reasoningEffort: parseRequiredString(
      raw.reasoningEffort,
      'reasoningEffort',
      problems,
    ),
    maxJobsPerTick: parsePositiveInteger(
      raw.maxJobsPerTick,
      // biome-ignore lint/security/noSecrets: a config key name, not a credential.
      'maxJobsPerTick',
      DEFAULT_MAX_JOBS_PER_TICK,
      problems,
    ),
    staleClaimHours: parsePositiveInteger(
      raw.staleClaimHours,
      'staleClaimHours',
      DEFAULT_STALE_CLAIM_HOURS,
      problems,
    ),
    runTimeoutMinutes: parsePositiveInteger(
      raw.runTimeoutMinutes,
      'runTimeoutMinutes',
      DEFAULT_RUN_TIMEOUT_MINUTES,
      problems,
    ),
    cacheDir: parseCacheDir(raw.cacheDir, configDir, problems),
    extraCodexArgs: parseExtraCodexArgs(raw.extraCodexArgs, problems),
  };
  if (config.staleClaimHours * MINUTES_PER_HOUR <= config.runTimeoutMinutes) {
    problems.push(
      'poller config "staleClaimHours" must exceed "runTimeoutMinutes": a shorter stale sweep would release the claim of a job that is still running',
    );
  }
  return problems.length > 0
    ? { config: null, problems }
    : { config, problems: [] };
};
