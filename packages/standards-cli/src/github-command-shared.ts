import type { GithubSettings } from './github-settings-parse';

export const optOutEligibilityProblem = (
  repo: string,
  declared: GithubSettings,
  liveRepository: Readonly<Record<string, unknown>>,
): string | null =>
  declared.rulesetEnforcement === 'unavailable-on-plan' &&
  liveRepository.private !== true
    ? `.github/settings.local.json "rulesetEnforcement" may only be declared for a private repository; ${repo} is public`
    : null;
