import { describe, expect, it } from 'bun:test';
import { resolveHiddenBypassActors } from './github-bypass-actors';

const actor = { actor_id: 5, actor_type: 'RepositoryRole' };

const RULESET_ID = 42;
const BYPASSED_ID = 7;
const CLEAN_ID = 8;
const BYPASS_COUNT = 3;

// What a token without repository Administration access sees, and the only
// thing a GitHub App installation token ever sees: no `bypass_actors` key.
const hidden = { id: RULESET_ID, name: 'Protect main', enforcement: 'active' };

const resolveOne = (
  declaredActors: ReadonlyArray<unknown>,
  counts: ReadonlyMap<number, number>,
  live: Readonly<Record<string, unknown>> = hidden,
): Readonly<Record<string, unknown>> =>
  resolveHiddenBypassActors(
    [{ name: 'Protect main', bypass_actors: declaredActors }],
    [live],
    counts,
  )[0] ?? {};

describe('resolveHiddenBypassActors', () => {
  it('pins the live list to empty when GraphQL counts zero', () => {
    expect(resolveOne([], new Map([[RULESET_ID, 0]]))).toEqual({
      ...hidden,
      bypass_actors: [],
    });
  });

  it('stands in unreadable actors when the count disagrees with the declaration', () => {
    const resolved = resolveOne([], new Map([[RULESET_ID, 2]]));
    expect(resolved.bypass_actors).toHaveLength(2);
  });

  it('never lets a stand-in look like a declared actor', () => {
    const resolved = resolveOne([actor], new Map([[RULESET_ID, 2]]));
    expect(resolved.bypass_actors).not.toContainEqual(actor);
  });

  it('leaves the list hidden when a non-zero count matches the declaration', () => {
    const resolved = resolveOne([actor], new Map([[RULESET_ID, 1]]));
    expect(resolved).not.toHaveProperty('bypass_actors');
  });

  it('leaves the list hidden for a ruleset GraphQL did not count', () => {
    expect(resolveOne([], new Map())).not.toHaveProperty('bypass_actors');
  });

  it('treats a list REST already answered as authoritative', () => {
    const live = { ...hidden, bypass_actors: [actor] };
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
    const clean = {
      id: CLEAN_ID,
      name: 'Protect main',
      enforcement: 'active',
    };
    const resolved = resolveHiddenBypassActors(
      [{ name: 'Protect main', bypass_actors: [] }],
      [bypassed, clean],
      new Map([
        [BYPASSED_ID, BYPASS_COUNT],
        [CLEAN_ID, 0],
      ]),
    );
    expect(resolved[0]?.bypass_actors).toHaveLength(BYPASS_COUNT);
    expect(resolved[1]?.bypass_actors).toEqual([]);
  });

  it('leaves a live ruleset without a numeric id hidden', () => {
    const noId = { name: 'Protect main', enforcement: 'active' };
    expect(resolveOne([], new Map([[RULESET_ID, 0]]), noId)).not.toHaveProperty(
      'bypass_actors',
    );
  });
});
