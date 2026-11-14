// The checks that a branch's rulesets and classic branch protection require,
// by name. A required check whose run hasn't started yet, such as one queued
// in a concurrency group, reports nothing, so only these names tell land that
// a blocked pull request still waits for it.

import { ghJson, type LandContext, type Repository } from './land-context';

// More active rules than one page holds on one branch would be a
// misconfiguration.
const RULES_PER_PAGE = 100;

// GitHub's REST fields are snake_case.
type Rule = {
  readonly type?: string;
  readonly parameters?: {
    // biome-ignore lint/style/useNamingConvention: GitHub's REST field.
    readonly required_status_checks?: ReadonlyArray<{
      readonly context?: string;
    }>;
  };
};

type Branch = {
  readonly protection?: {
    // biome-ignore lint/style/useNamingConvention: GitHub's REST field.
    readonly required_status_checks?: {
      // biome-ignore lint/style/useNamingConvention: GitHub's REST field.
      readonly enforcement_level?: string;
      readonly contexts?: ReadonlyArray<string>;
      readonly checks?: ReadonlyArray<{ readonly context?: string }>;
    } | null;
  } | null;
};

// Both lookups need only read access, also in private repositories.
export const requiredChecks = (
  context: LandContext,
  repo: Repository,
  branch: string,
): ReadonlySet<string> => {
  const path = `repos/${repo.nameWithOwner}`;
  const name = encodeURIComponent(branch);
  const rules = ghJson<ReadonlyArray<Rule>>(
    context,
    'api',
    `${path}/rules/branches/${name}?per_page=${RULES_PER_PAGE}`,
  );
  const classic = ghJson<Branch>(context, 'api', `${path}/branches/${name}`)
    .protection?.required_status_checks;
  const names = [
    ...rules
      .filter((rule) => rule.type === 'required_status_checks')
      .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
      .map((check) => check.context),
    ...(classic && classic.enforcement_level !== 'off'
      ? [
          ...(classic.contexts ?? []),
          ...(classic.checks ?? []).map((check) => check.context),
        ]
      : []),
  ];
  return new Set(
    names.filter((check): check is string => typeof check === 'string'),
  );
};
