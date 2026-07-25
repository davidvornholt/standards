// Reconciles ruleset bypass-actor lists REST hides, using the counts GraphQL
// answers for tokens that cannot read the actors themselves. Pure logic; the
// GraphQL call lives in github-graphql.ts.

import { BYPASS_ACTORS_KEY } from './github-ruleset-diff';

// Stand-ins for bypass actors GraphQL counted but would not name. They exist
// only to carry the count into the ordinary length comparison, and are attached
// exactly when the count and the declared length disagree or both are zero — so
// their content is never observed: subsetMatches short-circuits at the length
// check, two empty lists compare no element, and a declared ruleset with no
// bypass_actors array never reaches that comparison. Nothing else looks inside
// them; bypassActorCountDetail reads only `.length`, and github-live-drift.ts
// is the sole importer, so a stand-in cannot reach a PATCH body. The guarantee
// is not local: it also relies on declared ruleset names being unique, which
// github-settings-parse.ts and github-settings-merge.ts enforce.
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
//
// The counts are joined by ruleset id, the one identifier both APIs agree on:
// names are not unique on the live side, so joining on them could pin one
// ruleset's list from another ruleset's count. A live ruleset carrying no
// numeric id gets no count and stays hidden.
export const resolveHiddenBypassActors = (
  declared: ReadonlyArray<Readonly<Record<string, unknown>>>,
  live: ReadonlyArray<Readonly<Record<string, unknown>>>,
  counts: ReadonlyMap<number, number>,
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
    const count =
      typeof ruleset.id === 'number' ? counts.get(ruleset.id) : undefined;
    if (ruleset[BYPASS_ACTORS_KEY] !== undefined || count === undefined) {
      return ruleset;
    }
    return count > 0 && count === declaredCounts.get(String(ruleset.name))
      ? ruleset
      : { ...ruleset, [BYPASS_ACTORS_KEY]: unreadableBypassActors(count) };
  });
};
