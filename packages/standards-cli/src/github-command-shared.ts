import {
  ENFORCEMENT_OPT_OUT,
  type GithubSettings,
} from './github-settings-parse';

// Repository settings that only function alongside branch protection, which
// the ruleset-enforcement opt-out declares unavailable on the plan. GitHub
// answers a PATCH for them with HTTP 200 and silently keeps the old value, so
// they must be skipped, never applied-and-trusted.
export const PLAN_GATED_REPOSITORY_KEYS: ReadonlySet<string> = new Set([
  'allow_auto_merge',
]);

export const enforceableRepositorySettings = (
  declared: GithubSettings,
): Readonly<Record<string, unknown>> =>
  declared.rulesetEnforcement === ENFORCEMENT_OPT_OUT
    ? Object.fromEntries(
        Object.entries(declared.repository).filter(
          ([key]) => !PLAN_GATED_REPOSITORY_KEYS.has(key),
        ),
      )
    : declared.repository;

export const optOutEligibilityProblem = (
  repo: string,
  declared: GithubSettings,
  liveRepository: Readonly<Record<string, unknown>>,
): string | null =>
  declared.rulesetEnforcement === ENFORCEMENT_OPT_OUT &&
  liveRepository.private !== true
    ? `.github/settings.local.json "rulesetEnforcement" may only be declared for a private repository; ${repo} is public`
    : null;

// Declared state the token cannot see is a gate failure, not a pass with a
// log line: a gate that cannot perform its comparison fails closed.
export const unverifiableProblem = (
  scope: string,
  items: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  items.length === 0
    ? []
    : [
        `${scope} not visible to this token, so the gate cannot verify: ${items.join('; ')}. Use a token with read access to repository administration (in CI: ci.github_settings_read_token in secrets/ci.yaml), or verify locally with admin auth`,
      ];
