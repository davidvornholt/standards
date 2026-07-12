// Drift comparison between declared GitHub settings (github-settings.ts) and
// the live state returned by the GitHub API. Pure logic; no network.

import { isRecord } from './github-settings';

// Declared values must match live ones; keys GitHub adds to live objects are
// ignored so new API defaults do not read as drift. Arrays must have the same
// length, with each declared element matching a distinct live element — so an
// added bypass actor or required check is drift even when the declared list is
// a subset of the live one.
export const subsetMatches = (declared: unknown, live: unknown): boolean => {
  if (Array.isArray(declared)) {
    if (!Array.isArray(live) || declared.length !== live.length) {
      return false;
    }
    const remaining = [...(live as ReadonlyArray<unknown>)];
    return declared.every((value) => {
      const index = remaining.findIndex((candidate) =>
        subsetMatches(value, candidate),
      );
      if (index === -1) {
        return false;
      }
      remaining.splice(index, 1);
      return true;
    });
  }
  if (isRecord(declared)) {
    return (
      isRecord(live) &&
      Object.entries(declared).every(([key, value]) =>
        subsetMatches(value, live[key]),
      )
    );
  }
  return declared === live;
};

const RULESET_COMPARED_KEYS = [
  'target',
  'enforcement',
  'conditions',
  'bypass_actors',
] as const;

export const diffRuleset = (
  declared: Readonly<Record<string, unknown>>,
  live: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> => {
  const name = String(declared.name);
  const problems: Array<string> = [];
  for (const key of RULESET_COMPARED_KEYS) {
    if (
      declared[key] !== undefined &&
      !subsetMatches(declared[key], live[key])
    ) {
      problems.push(
        `ruleset "${name}": ${key} differs from the declared configuration`,
      );
    }
  }
  const declaredRules = Array.isArray(declared.rules)
    ? declared.rules.filter(isRecord)
    : [];
  const liveRules = Array.isArray(live.rules)
    ? live.rules.filter(isRecord)
    : [];
  const liveByType = new Map(
    liveRules.map((rule) => [String(rule.type), rule]),
  );
  const declaredTypes = new Set(declaredRules.map((rule) => String(rule.type)));
  for (const rule of declaredRules) {
    const type = String(rule.type);
    const liveRule = liveByType.get(type);
    const declaredWithoutType = Object.fromEntries(
      Object.entries(rule).filter(([key]) => key !== 'type'),
    );
    if (liveRule === undefined) {
      problems.push(`ruleset "${name}": missing rule "${type}"`);
    } else if (!subsetMatches(declaredWithoutType, liveRule)) {
      problems.push(
        `ruleset "${name}": rule "${type}" differs from the declared configuration`,
      );
    }
  }
  for (const type of liveByType.keys()) {
    if (!declaredTypes.has(type)) {
      problems.push(`ruleset "${name}": has undeclared extra rule "${type}"`);
    }
  }
  return problems;
};

// Live rulesets must be exactly the declared set: additions, removals, and
// in-place edits are all drift.
export const diffRulesets = (
  declared: ReadonlyArray<Readonly<Record<string, unknown>>>,
  live: ReadonlyArray<Readonly<Record<string, unknown>>>,
): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const liveByName = new Map(
    live.map((ruleset) => [String(ruleset.name), ruleset]),
  );
  const declaredNames = new Set(
    declared.map((ruleset) => String(ruleset.name)),
  );
  for (const ruleset of declared) {
    const liveRuleset = liveByName.get(String(ruleset.name));
    if (liveRuleset === undefined) {
      problems.push(
        `ruleset "${ruleset.name}" is declared but missing on GitHub`,
      );
    } else {
      problems.push(...diffRuleset(ruleset, liveRuleset));
    }
  }
  for (const name of liveByName.keys()) {
    if (!declaredNames.has(name)) {
      problems.push(
        `ruleset "${name}" exists on GitHub but is not declared; declare it in .github/settings.local.json or delete it`,
      );
    }
  }
  return problems;
};

export type RepositoryDiff = {
  readonly drifted: ReadonlyArray<string>;
  readonly unverifiable: ReadonlyArray<string>;
};

// Repo merge settings are only visible to admin tokens; report invisible keys
// as unverifiable instead of drifted so a non-admin CI token does not fail the
// gate, while still surfacing that only a local admin check gives full
// coverage.
export const diffRepositorySettings = (
  declared: Readonly<Record<string, unknown>>,
  live: Readonly<Record<string, unknown>>,
): RepositoryDiff => {
  const drifted: Array<string> = [];
  const unverifiable: Array<string> = [];
  for (const [key, value] of Object.entries(declared)) {
    if (live[key] === undefined) {
      unverifiable.push(key);
    } else if (!subsetMatches(value, live[key])) {
      drifted.push(
        `repository setting "${key}" is ${JSON.stringify(live[key])} on GitHub, declared ${JSON.stringify(value)}`,
      );
    }
  }
  return { drifted, unverifiable };
};
