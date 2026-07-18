// Shape parsing for a single declarative GitHub settings file: the canonical
// `.github/settings.json` or the repo-owned `.github/settings.local.json`
// extension. Seam merging lives in github-settings.ts, drift comparison in
// github-diff.ts, and the API interaction in github-api.ts. Like cli.ts, this
// module is zero-dependency so `bunx` can execute the published package.

// GitHub only enforces rulesets on private repositories on paid plans. The
// seam can declare that fact so the gate skips rulesets loudly instead of
// failing closed forever (personal accounts) or trusting rulesets the API
// reports as active but a free-plan organization silently does not enforce.
export type RulesetEnforcement = 'enforced' | 'unavailable-on-plan';

export type GithubSettings = {
  readonly repository: Readonly<Record<string, unknown>>;
  readonly rulesets: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly rulesetEnforcement: RulesetEnforcement;
};

export type ParsedGithubSettings = {
  readonly repository: Readonly<Record<string, unknown>> | null;
  readonly rulesets: ReadonlyArray<unknown> | null;
  readonly rulesetEnforcement: RulesetEnforcement | null;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

export const isNamedRuleset = (
  value: unknown,
): value is Readonly<Record<string, unknown>> & { readonly name: string } =>
  isRecord(value) && typeof value.name === 'string' && value.name.length > 0;

export const SETTINGS_KEYS: ReadonlySet<string> = new Set([
  'repository',
  'rulesets',
]);
export const LOCAL_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  ...SETTINGS_KEYS,
  'rulesetEnforcement',
]);

export const ENFORCEMENT_OPT_OUT = 'unavailable-on-plan';

export type ParseResult = {
  readonly settings: ParsedGithubSettings | null;
  readonly problems: ReadonlyArray<string>;
};

const parseRulesetEnforcement = (value: unknown): RulesetEnforcement | null => {
  if (value === undefined) {
    return 'enforced';
  }
  return value === ENFORCEMENT_OPT_OUT ? ENFORCEMENT_OPT_OUT : null;
};

const rulesetListProblems = (
  rulesets: ReadonlyArray<unknown>,
  label: string,
): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const names = new Set<string>();
  for (const [index, ruleset] of rulesets.entries()) {
    if (!isNamedRuleset(ruleset)) {
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

export const parseSettings = (
  raw: unknown,
  label: string,
  allowedKeys: ReadonlySet<string>,
): ParseResult => {
  if (!isRecord(raw)) {
    return { settings: null, problems: [`${label} must be a JSON object`] };
  }
  const problems: Array<string> = [];
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
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
  // Only the opt-out value is accepted: enforcement is the default, and an
  // explicit "enforced" would be a second way to spell the same state.
  if (
    raw.rulesetEnforcement !== undefined &&
    raw.rulesetEnforcement !== ENFORCEMENT_OPT_OUT
  ) {
    problems.push(
      `${label} "rulesetEnforcement" must be "${ENFORCEMENT_OPT_OUT}" when present; omit it on plans where GitHub enforces rulesets`,
    );
  }
  return {
    settings: {
      repository: isRecord(repository) ? repository : null,
      rulesets: Array.isArray(rulesets) ? rulesets : null,
      rulesetEnforcement: parseRulesetEnforcement(raw.rulesetEnforcement),
    },
    problems,
  };
};
