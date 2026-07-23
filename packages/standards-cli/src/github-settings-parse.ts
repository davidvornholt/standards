// Shape parsing for a single declarative GitHub settings file: the canonical
// `.github/settings.json` or the repo-owned `.github/settings.local.json`
// extension. Seam merging lives in github-settings.ts, drift comparison in
// github-diff.ts, and the API interaction in github-api.ts. Like cli.ts, this
// module is zero-dependency so `bunx` can execute the published package.

import { labelIdentity } from './github-label-identity';

// GitHub only enforces rulesets on private repositories on paid plans. The
// seam can declare that fact so the gate skips rulesets loudly instead of
// failing closed forever (personal accounts) or trusting rulesets the API
// reports as active but a free-plan organization silently does not enforce.
export type RulesetEnforcement = 'enforced' | 'unavailable-on-plan';

// Declared issue labels are an additive floor like rulesets: declared labels
// must exist with the declared color and description; extra live labels are
// not drift. The fix-poller protocol labels ride this seam to every consumer.
export type LabelDeclaration = {
  readonly name: string;
  readonly color: string;
  readonly description: string;
};

export type GithubSettings = {
  readonly repository: Readonly<Record<string, unknown>>;
  readonly rulesets: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly labels: ReadonlyArray<LabelDeclaration>;
  readonly rulesetEnforcement: RulesetEnforcement;
};

export type ParsedGithubSettings = {
  readonly repository: Readonly<Record<string, unknown>> | null;
  readonly rulesets: ReadonlyArray<unknown> | null;
  readonly labels: ReadonlyArray<unknown> | null;
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

const LABEL_COLOR = /^[0-9a-f]{6}$/u;
const LABEL_DECLARATION_KEY_COUNT = 3;

export const isLabelDeclaration = (value: unknown): value is LabelDeclaration =>
  isRecord(value) &&
  Object.keys(value).length === LABEL_DECLARATION_KEY_COUNT &&
  isNonEmptyString(value.name) &&
  typeof value.color === 'string' &&
  LABEL_COLOR.test(value.color) &&
  isNonEmptyString(value.description);

export const SETTINGS_KEYS: ReadonlySet<string> = new Set([
  'repository',
  'rulesets',
  'labels',
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

const labelListProblems = (
  labels: ReadonlyArray<unknown>,
  label: string,
): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const names = new Set<string>();
  for (const [index, declaration] of labels.entries()) {
    if (!isLabelDeclaration(declaration)) {
      problems.push(
        `${label} labels[${index}] must be {"name","color","description"} with a non-empty name, a 6-digit lowercase hex color, and a non-empty description`,
      );
    } else if (names.has(labelIdentity(declaration.name))) {
      problems.push(
        `${label} declares label "${declaration.name}" more than once`,
      );
    } else {
      names.add(labelIdentity(declaration.name));
    }
  }
  return problems;
};

type ListField = {
  readonly label: string;
  readonly field: string;
  readonly listProblems: (
    list: ReadonlyArray<unknown>,
    label: string,
  ) => ReadonlyArray<string>;
};

const parseDeclarationList = (
  raw: unknown,
  options: ListField,
  problems: Array<string>,
): ReadonlyArray<unknown> | null => {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    problems.push(`${options.label} "${options.field}" must be an array`);
    return null;
  }
  problems.push(...options.listProblems(raw, options.label));
  return raw;
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
  const repository = 'repository' in raw ? raw.repository : {};
  if (!isRecord(repository)) {
    problems.push(`${label} "repository" must be an object`);
  }
  const rulesets = parseDeclarationList(
    raw.rulesets,
    { label, field: 'rulesets', listProblems: rulesetListProblems },
    problems,
  );
  const labels = parseDeclarationList(
    raw.labels,
    { label, field: 'labels', listProblems: labelListProblems },
    problems,
  );
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
      rulesets,
      labels,
      rulesetEnforcement: parseRulesetEnforcement(raw.rulesetEnforcement),
    },
    problems,
  };
};
