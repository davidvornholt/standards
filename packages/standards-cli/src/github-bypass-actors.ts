// Reconciles ruleset bypass-actor lists REST hides, using the counts GraphQL
// answers for tokens that cannot read the actors themselves. Pure logic; the
// GraphQL call lives in github-graphql.ts.

export const BYPASS_ACTORS_KEY = 'bypass_actors';

// Tells a hidden bypass-actor list apart from any other invisible ruleset
// field, so callers can retry only that one over GraphQL.
export const isHiddenBypassActorsProblem = (problem: string): boolean =>
  problem.endsWith(`: ${BYPASS_ACTORS_KEY}`);

// Stand-ins for bypass actors GraphQL counted but would not name. They exist
// only to carry the count into the ordinary length comparison, so they are
// deliberately unmatchable: a declared actor must never appear to match one.
const unreadableBypassActors = (count: number): ReadonlyArray<unknown> =>
  Array.from({ length: count }, (_unused, index) => ({
    unreadableBypassActor: index,
  }));

// A count of zero pins the live list to the empty list exactly. A count that
// disagrees with the declared length is drift no identity could explain, so
// that many unreadable actors stand in and the ordinary comparison reports it.
// A matching non-zero count proves nothing about *which* actors bypass, so the
// field stays hidden and the gate fails closed on it. A list REST already
// answered is authoritative and never replaced.
export const resolveHiddenBypassActors = (
  declared: ReadonlyArray<Readonly<Record<string, unknown>>>,
  live: ReadonlyArray<Readonly<Record<string, unknown>>>,
  counts: ReadonlyMap<string, number>,
): ReadonlyArray<Readonly<Record<string, unknown>>> => {
  const declaredCounts = new Map(
    declared
      .filter((ruleset) => Array.isArray(ruleset[BYPASS_ACTORS_KEY]))
      .map((ruleset) => [
        String(ruleset.name),
        (ruleset[BYPASS_ACTORS_KEY] as ReadonlyArray<unknown>).length,
      ]),
  );
  return live.map((ruleset) => {
    const name = String(ruleset.name);
    const count = counts.get(name);
    if (ruleset[BYPASS_ACTORS_KEY] !== undefined || count === undefined) {
      return ruleset;
    }
    return count > 0 && count === declaredCounts.get(name)
      ? ruleset
      : { ...ruleset, [BYPASS_ACTORS_KEY]: unreadableBypassActors(count) };
  });
};
