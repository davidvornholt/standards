import { rulesProblems } from './github-ruleset-rule-settings';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const RULESET_COMPARED_KEYS = [
  'target',
  'enforcement',
  'conditions',
  'bypass_actors',
] as const;
const RULESET_KEYS = new Set(['name', ...RULESET_COMPARED_KEYS, 'rules']);
const CONDITION_KEYS = new Set(['ref_name']);
const REF_NAME_KEYS = new Set(['include', 'exclude']);

const unknownKeyProblems = (
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  prefix: string,
): ReadonlyArray<string> =>
  Object.keys(value).flatMap((key) =>
    allowed.has(key) ? [] : [`${prefix} has unknown key "${key}"`],
  );

const stringArrayProblems = (
  value: unknown,
  prefix: string,
  requireValue: boolean,
): ReadonlyArray<string> => {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    return [`${prefix} must be an array of non-empty strings`];
  }
  return [
    ...(requireValue && value.length === 0
      ? [`${prefix} must not be empty`]
      : []),
    ...(new Set(value).size === value.length
      ? []
      : [`${prefix} must not contain duplicates`]),
  ];
};

const conditionsProblems = (
  value: unknown,
  prefix: string,
): ReadonlyArray<string> => {
  if (!isRecord(value)) {
    return [`${prefix} must contain a ref_name condition`];
  }
  const refName = value.ref_name;
  if (!isRecord(refName)) {
    return [
      ...unknownKeyProblems(value, CONDITION_KEYS, prefix),
      `${prefix}.ref_name must be an object`,
    ];
  }
  return [
    ...unknownKeyProblems(value, CONDITION_KEYS, prefix),
    ...unknownKeyProblems(refName, REF_NAME_KEYS, `${prefix}.ref_name`),
    ...stringArrayProblems(refName.include, `${prefix}.ref_name.include`, true),
    ...stringArrayProblems(
      refName.exclude,
      `${prefix}.ref_name.exclude`,
      false,
    ),
  ];
};

export const rulesetListProblems = (
  rulesets: ReadonlyArray<unknown>,
  label: string,
): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const names = new Set<string>();
  for (const [index, ruleset] of rulesets.entries()) {
    const prefix = `${label} rulesets[${index}]`;
    if (isRecord(ruleset) && typeof ruleset.name === 'string') {
      if (names.has(ruleset.name)) {
        problems.push(
          `${label} declares ruleset "${ruleset.name}" more than once`,
        );
      }
      names.add(ruleset.name);
    }
    problems.push(...rulesetProblems(ruleset, prefix));
  }
  return problems;
};

const rulesetProblems = (
  ruleset: unknown,
  prefix: string,
): ReadonlyArray<string> => {
  if (
    !isRecord(ruleset) ||
    typeof ruleset.name !== 'string' ||
    ruleset.name.length === 0
  ) {
    return [`${prefix} must be an object with a non-empty "name"`];
  }
  return [
    ...unknownKeyProblems(ruleset, RULESET_KEYS, prefix),
    ...(ruleset.target === 'branch'
      ? []
      : [`${prefix}.target must be "branch"`]),
    ...(ruleset.enforcement === 'active'
      ? []
      : [`${prefix}.enforcement must be "active"`]),
    ...conditionsProblems(ruleset.conditions, `${prefix}.conditions`),
    ...(Array.isArray(ruleset.bypass_actors) &&
    ruleset.bypass_actors.length === 0
      ? []
      : [`${prefix}.bypass_actors must be an empty array`]),
    ...rulesProblems(ruleset.rules, `${prefix}.rules`),
  ];
};
