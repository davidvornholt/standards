// Drift comparison between declared GitHub settings (github-settings.ts) and
// the live state returned by the GitHub API. Pure logic; no network. Ruleset
// comparison lives in github-ruleset-diff.ts.

import { isRecord } from './github-settings-parse';

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

// Repo merge settings are only visible to admin tokens; report invisible keys
// as unverifiable instead of drifted so callers fail the gate with a
// missing-visibility message that names the token fix, not a bogus value
// mismatch.
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
