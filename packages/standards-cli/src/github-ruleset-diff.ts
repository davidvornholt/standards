// Drift comparison for repository rulesets: the declared set
// (github-settings.ts) against live API state. Pure logic; no network. The
// general value comparison lives in github-diff.ts.

import { subsetMatches } from './github-diff';
import { isRecord } from './github-settings-parse';

export const BYPASS_ACTORS_KEY = 'bypass_actors';

// A declared ruleset field the live side did not carry. It stays structured so
// the caller owns both the wording and the test for *which* field it is;
// formatting it here and recovering the signal by parsing the message suffix
// would let a reformat silently disable the bypass-actor fallback.
export type UnverifiableRulesetField = {
  readonly key: string;
  readonly name: string;
};

export type RulesetDiff = {
  readonly drifted: ReadonlyArray<string>;
  readonly unverifiable: ReadonlyArray<UnverifiableRulesetField>;
};

const RULESET_COMPARED_KEYS = [
  'target',
  'enforcement',
  'conditions',
  BYPASS_ACTORS_KEY,
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

// Whoever hits bypass-actor drift holds, by construction, a token that cannot
// name the actors, so the two lengths are the only facts worth printing — and
// when the live list is stand-ins for a GraphQL count, they are the only facts
// that exist. Equal lengths mean the identities differ, where a count would
// say nothing.
const bypassActorCountDetail = (
  key: string,
  declared: unknown,
  live: unknown,
): string =>
  key === BYPASS_ACTORS_KEY &&
  Array.isArray(declared) &&
  Array.isArray(live) &&
  declared.length !== live.length
    ? ` (GitHub reports ${live.length} bypass actor(s); ${declared.length} declared)`
    : '';

// Some ruleset fields — bypass_actors in particular — are only included in
// API responses for admin viewers. A declared key that is absent on the live
// side is unverifiable for this token, not drift: the same policy as
// repository merge settings, so callers can fail with a targeted
// missing-visibility message instead of a bogus value mismatch. The live side
// is not always an API response — github-bypass-actors.ts synthesises
// unmatchable stand-in actors from a GraphQL count — so a `bypass_actors` list
// arriving here may encode a count GitHub answered rather than actors it
// named.
export const diffRuleset = (
  declared: Readonly<Record<string, unknown>>,
  live: Readonly<Record<string, unknown>>,
): RulesetDiff => {
  const name = String(declared.name);
  const drifted: Array<string> = [];
  const unverifiable: Array<UnverifiableRulesetField> = [];
  for (const key of RULESET_COMPARED_KEYS) {
    if (declared[key] === undefined) {
      continue;
    }
    if (live[key] === undefined) {
      unverifiable.push({ key, name });
    } else if (!subsetMatches(declared[key], live[key])) {
      drifted.push(
        `ruleset "${name}": ${key} differs from the declared configuration${bypassActorCountDetail(key, declared[key], live[key])}`,
      );
    }
  }
  drifted.push(...diffRules(name, declared, live));
  return { drifted, unverifiable };
};

const groupLiveByName = (
  live: ReadonlyArray<Readonly<Record<string, unknown>>>,
): ReadonlyMap<string, ReadonlyArray<Readonly<Record<string, unknown>>>> => {
  const groups = new Map<string, Array<Readonly<Record<string, unknown>>>>();
  for (const ruleset of live) {
    const group = groups.get(String(ruleset.name));
    if (group === undefined) {
      groups.set(String(ruleset.name), [ruleset]);
    } else {
      group.push(ruleset);
    }
  }
  return groups;
};

// GitHub does not require repository ruleset names to be unique, and the
// declaration addresses rulesets by name alone. Picking one of a colliding
// pair would compare the harmless one, pass, and never mention the other — a
// bypassed default branch reported as converged — so a collision fails the
// gate outright and names the ids that make it ambiguous.
const nameCollisionDrift = (
  name: string,
  group: ReadonlyArray<Readonly<Record<string, unknown>>>,
): string =>
  `ruleset name "${name}" is used by ${group.length} rulesets on GitHub (ids ${group.map((ruleset) => String(ruleset.id)).join(', ')}); the declaration addresses rulesets by name, so none of them can be verified until all but one is renamed or deleted`;

// Live rulesets must be exactly the declared set: additions, removals, and
// in-place edits are all drift.
export const diffRulesets = (
  declared: ReadonlyArray<Readonly<Record<string, unknown>>>,
  live: ReadonlyArray<Readonly<Record<string, unknown>>>,
): RulesetDiff => {
  const drifted: Array<string> = [];
  const unverifiable: Array<UnverifiableRulesetField> = [];
  const liveByName = groupLiveByName(live);
  const declaredNames = new Set(
    declared.map((ruleset) => String(ruleset.name)),
  );
  for (const ruleset of declared) {
    const group = liveByName.get(String(ruleset.name)) ?? [];
    const [only] = group;
    if (group.length > 1) {
      continue;
    }
    if (only === undefined) {
      drifted.push(
        `ruleset "${ruleset.name}" is declared but missing on GitHub`,
      );
    } else {
      const diff = diffRuleset(ruleset, only);
      drifted.push(...diff.drifted);
      unverifiable.push(...diff.unverifiable);
    }
  }
  for (const [name, group] of liveByName) {
    if (group.length > 1) {
      drifted.push(nameCollisionDrift(name, group));
    }
    if (!declaredNames.has(name)) {
      drifted.push(
        `ruleset "${name}" exists on GitHub but is not declared; declare it in .github/settings.local.json or delete it`,
      );
    }
  }
  return { drifted, unverifiable };
};
