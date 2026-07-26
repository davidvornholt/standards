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

export const ADMIN_VISIBILITY_ADVICE =
  'Use a user-scoped token with read access to repository administration, or verify locally with admin auth; a CI token cannot hold that access, so widening what CI reads with is not the fix';

// Merge settings have a different remedy from everything else this advice used
// to cover. GraphQL serves them to read-only tokens by design, so reaching this
// message means the fallback request itself failed — pointing the reader at a
// permission they cannot obtain would send them after the wrong cause.
export const MERGE_SETTINGS_VISIBILITY_ADVICE =
  'REST serves repository merge settings only to write-level viewers, and the GraphQL fallback that answers them for a read-only token did not respond, so this is more likely a failed request than a permission gap: re-run the check, and if it keeps failing verify locally with admin auth';

// Declared state the token cannot see is a gate failure, not a pass with a
// log line: a gate that cannot perform its comparison fails closed. The advice
// is the caller's, because not every invisible field has the same remedy —
// ruleset bypass actors in particular are unreachable over REST for an
// installation token at any permission level.
export const unverifiableProblem = (
  scope: string,
  items: ReadonlyArray<string>,
  advice: string,
): ReadonlyArray<string> =>
  items.length === 0
    ? []
    : [
        `${scope} not visible to this token, so the gate cannot verify: ${items.join('; ')}. ${advice}`,
      ];
