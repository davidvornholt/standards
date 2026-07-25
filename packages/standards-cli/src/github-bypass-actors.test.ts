import { describe, expect, it } from 'bun:test';
import { resolveHiddenBypassActors } from './github-bypass-actors';
import { BYPASS_ACTORS_KEY, diffRulesets } from './github-ruleset-diff';

// The GitHub wire format is snake_case; fixtures come through JSON.parse and
// the computed BYPASS_ACTORS_KEY so those literals never become identifiers.
const actorWithId = (id: number): Readonly<Record<string, unknown>> =>
  JSON.parse(
    `{"actor_id":${String(id)},"actor_type":"RepositoryRole"}`,
  ) as Readonly<Record<string, unknown>>;

const DECLARED_ACTOR_ID = 5;
const actor = actorWithId(DECLARED_ACTOR_ID);

const RULESET_ID = 42;
const BYPASSED_ID = 7;
const CLEAN_ID = 8;
const BYPASS_COUNT = 3;

// What a token without repository Administration access sees, and the only
// thing a GitHub App installation token ever sees: no `bypass_actors` key.
const hidden = { id: RULESET_ID, name: 'Protect main', enforcement: 'active' };

const declaredWith = (
  actors: ReadonlyArray<unknown>,
): Readonly<Record<string, unknown>> => ({
  name: 'Protect main',
  [BYPASS_ACTORS_KEY]: actors,
});

const resolveOne = (
  declaredActors: ReadonlyArray<unknown>,
  counts: ReadonlyMap<number, number>,
  live: Readonly<Record<string, unknown>> = hidden,
): Readonly<Record<string, unknown>> =>
  resolveHiddenBypassActors(
    [declaredWith(declaredActors)],
    [live],
    counts,
  )[0] ?? {};

describe('resolveHiddenBypassActors', () => {
  it('pins the live list to empty when GraphQL counts zero', () => {
    expect(resolveOne([], new Map([[RULESET_ID, 0]]))).toEqual({
      ...hidden,
      [BYPASS_ACTORS_KEY]: [],
    });
  });

  it('leaves the list hidden when a non-zero count matches the declaration', () => {
    const resolved = resolveOne([actor], new Map([[RULESET_ID, 1]]));
    expect(resolved).not.toHaveProperty(BYPASS_ACTORS_KEY);
  });

  it('leaves the list hidden for a ruleset GraphQL did not count', () => {
    expect(resolveOne([], new Map())).not.toHaveProperty(BYPASS_ACTORS_KEY);
  });

  it('treats a list REST already answered as authoritative', () => {
    const live = { ...hidden, [BYPASS_ACTORS_KEY]: [actor] };
    expect(resolveOne([], new Map([[RULESET_ID, 0]]), live)).toEqual(live);
  });

  // A count keyed by name would let the harmless twin of a colliding pair
  // verify the bypassed one; keyed by id, only the ruleset GraphQL counted is
  // ever pinned.
  it('joins counts by ruleset id, not by name', () => {
    const bypassed = {
      id: BYPASSED_ID,
      name: 'Protect main',
      enforcement: 'active',
    };
    const clean = { id: CLEAN_ID, name: 'Protect main', enforcement: 'active' };
    const resolved = resolveHiddenBypassActors(
      [declaredWith([])],
      [bypassed, clean],
      new Map([
        [BYPASSED_ID, BYPASS_COUNT],
        [CLEAN_ID, 0],
      ]),
    );
    expect(resolved[0]?.[BYPASS_ACTORS_KEY]).toHaveLength(BYPASS_COUNT);
    expect(resolved[1]?.[BYPASS_ACTORS_KEY]).toEqual([]);
  });

  it('leaves a live ruleset without a numeric id hidden', () => {
    const noId = { name: 'Protect main', enforcement: 'active' };
    expect(resolveOne([], new Map([[RULESET_ID, 0]]), noId)).not.toHaveProperty(
      BYPASS_ACTORS_KEY,
    );
  });
});

// The stand-in actors are an internal carrier, not a value to assert on: they
// exist only so the count reaches the ordinary length comparison, and by
// construction they are only ever built when the count already disagrees with
// the declaration. What is worth pinning is therefore the end state the whole
// reconciliation exists to guarantee — a count GitHub answered that disagrees
// with the declared list is drift the operator is told about, never a pass and
// never a visibility gap that a `--check` run could shrug off.
describe('resolveHiddenBypassActors feeding diffRulesets', () => {
  it.each([
    [0, 1],
    [1, 0],
    [1, 2],
    [BYPASS_COUNT, 1],
  ])('reports drift for %p declared actors against a count of %p', (declaredCount, count) => {
    const declared = [
      declaredWith(
        Array.from({ length: declaredCount }, (_u, i) => actorWithId(i)),
      ),
    ];
    const diff = diffRulesets(
      declared,
      resolveHiddenBypassActors(
        declared,
        [hidden],
        new Map([[RULESET_ID, count]]),
      ),
    );
    expect(diff.unverifiable).toEqual([]);
    expect(diff.drifted).toEqual([
      `ruleset "Protect main": ${BYPASS_ACTORS_KEY} differs from the declared configuration (GitHub reports ${String(count)} bypass actor(s); ${String(declaredCount)} declared)`,
    ]);
  });

  // The counted-and-matched case is the one state that stays unverifiable
  // rather than passing: the count proves how many actors bypass, never which.
  it('keeps a matching non-zero count unverifiable rather than passing', () => {
    const declared = [declaredWith([actor])];
    const diff = diffRulesets(
      declared,
      resolveHiddenBypassActors(declared, [hidden], new Map([[RULESET_ID, 1]])),
    );
    expect(diff.drifted).toEqual([]);
    expect(diff.unverifiable).toEqual([
      { key: BYPASS_ACTORS_KEY, name: 'Protect main' },
    ]);
  });
});
