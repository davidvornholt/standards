// Drift comparison between declared GitHub settings (github-settings.ts) and
// the live state returned by the GitHub API. Pure logic; no network.

import { isRecord } from './github-settings';

export type SettingsDiff = {
  readonly drifted: ReadonlyArray<string>;
  readonly unverifiable: ReadonlyArray<string>;
};

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

const diffRules = (
  name: string,
  declared: Readonly<Record<string, unknown>>,
  live: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> => {
  const drifted: Array<string> = [];
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
      drifted.push(`ruleset "${name}": missing rule "${type}"`);
    } else if (!subsetMatches(declaredWithoutType, liveRule)) {
      drifted.push(
        `ruleset "${name}": rule "${type}" differs from the declared configuration`,
      );
    }
  }
  for (const type of liveByType.keys()) {
    if (!declaredTypes.has(type)) {
      drifted.push(`ruleset "${name}": has undeclared extra rule "${type}"`);
    }
  }
  return drifted;
};

// Some ruleset fields — bypass_actors in particular — are only included in
// API responses for admin viewers. A declared key that is absent on the live
// side is unverifiable for this token, not drift: the same policy as
// repository merge settings, so a non-admin CI token does not fail the gate
// on state it cannot see.
export const diffRuleset = (
  declared: Readonly<Record<string, unknown>>,
  live: Readonly<Record<string, unknown>>,
): SettingsDiff => {
  const name = String(declared.name);
  const drifted: Array<string> = [];
  const unverifiable: Array<string> = [];
  for (const key of RULESET_COMPARED_KEYS) {
    if (declared[key] !== undefined) {
      if (live[key] === undefined) {
        unverifiable.push(`ruleset "${name}": ${key}`);
      } else if (!subsetMatches(declared[key], live[key])) {
        drifted.push(
          `ruleset "${name}": ${key} differs from the declared configuration`,
        );
      }
    }
  }
  drifted.push(...diffRules(name, declared, live));
  return { drifted, unverifiable };
};

// Live rulesets must be exactly the declared set: additions, removals, and
// in-place edits are all drift.
export const diffRulesets = (
  declared: ReadonlyArray<Readonly<Record<string, unknown>>>,
  live: ReadonlyArray<Readonly<Record<string, unknown>>>,
): SettingsDiff => {
  const drifted: Array<string> = [];
  const unverifiable: Array<string> = [];
  const liveByName = new Map(
    live.map((ruleset) => [String(ruleset.name), ruleset]),
  );
  const declaredNames = new Set(
    declared.map((ruleset) => String(ruleset.name)),
  );
  for (const ruleset of declared) {
    const liveRuleset = liveByName.get(String(ruleset.name));
    if (liveRuleset === undefined) {
      drifted.push(
        `ruleset "${ruleset.name}" is declared but missing on GitHub`,
      );
    } else {
      const diff = diffRuleset(ruleset, liveRuleset);
      drifted.push(...diff.drifted);
      unverifiable.push(...diff.unverifiable);
    }
  }
  for (const name of liveByName.keys()) {
    if (!declaredNames.has(name)) {
      drifted.push(
        `ruleset "${name}" exists on GitHub but is not declared; declare it in .github/settings.local.json or delete it`,
      );
    }
  }
  return { drifted, unverifiable };
};

// Repo merge settings are only visible to admin tokens; report invisible keys
// as unverifiable instead of drifted so a non-admin CI token does not fail the
// gate, while still surfacing that only a local admin check gives full
// coverage.
export const diffRepositorySettings = (
  declared: Readonly<Record<string, unknown>>,
  live: Readonly<Record<string, unknown>>,
): SettingsDiff => {
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

const ENVIRONMENT_COMPARED_KEYS = [
  'wait_timer',
  'prevent_self_review',
  'reviewers',
  'deployment_branch_policy',
  'custom_deployment_protection_rules',
] as const;

export const diffEnvironment = (
  declared: Readonly<Record<string, unknown>>,
  live: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> => {
  const name = String(declared.name);
  const drifted: Array<string> = [];
  for (const key of ENVIRONMENT_COMPARED_KEYS) {
    const declaredValue =
      key === 'custom_deployment_protection_rules' ? [] : declared[key];
    if (!subsetMatches(declaredValue, live[key])) {
      drifted.push(
        `environment "${name}": ${key} differs from the declared configuration`,
      );
    }
  }
  return drifted;
};
