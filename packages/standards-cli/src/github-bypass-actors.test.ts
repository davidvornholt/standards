import { describe, expect, it } from 'bun:test';
import {
  isHiddenBypassActorsProblem,
  resolveHiddenBypassActors,
} from './github-bypass-actors';

const actor = { actor_id: 5, actor_type: 'RepositoryRole' };

// What a token without repository Administration access sees, and the only
// thing a GitHub App installation token ever sees: no `bypass_actors` key.
const hidden = { id: 42, name: 'Protect main', enforcement: 'active' };

const resolveOne = (
  declaredActors: ReadonlyArray<unknown>,
  counts: ReadonlyMap<string, number>,
  live: Readonly<Record<string, unknown>> = hidden,
): Readonly<Record<string, unknown>> =>
  resolveHiddenBypassActors(
    [{ name: 'Protect main', bypass_actors: declaredActors }],
    [live],
    counts,
  )[0] ?? {};

describe('resolveHiddenBypassActors', () => {
  it('pins the live list to empty when GraphQL counts zero', () => {
    expect(resolveOne([], new Map([['Protect main', 0]]))).toEqual({
      ...hidden,
      bypass_actors: [],
    });
  });

  it('stands in unreadable actors when the count disagrees with the declaration', () => {
    const resolved = resolveOne([], new Map([['Protect main', 2]]));
    expect(resolved.bypass_actors).toHaveLength(2);
  });

  it('never lets a stand-in look like a declared actor', () => {
    const resolved = resolveOne([actor], new Map([['Protect main', 2]]));
    expect(resolved.bypass_actors).not.toContainEqual(actor);
  });

  it('leaves the list hidden when a non-zero count matches the declaration', () => {
    const resolved = resolveOne([actor], new Map([['Protect main', 1]]));
    expect(resolved).not.toHaveProperty('bypass_actors');
  });

  it('leaves the list hidden for a ruleset GraphQL did not count', () => {
    expect(resolveOne([], new Map())).not.toHaveProperty('bypass_actors');
  });

  it('treats a list REST already answered as authoritative', () => {
    const live = { ...hidden, bypass_actors: [actor] };
    expect(resolveOne([], new Map([['Protect main', 0]]), live)).toEqual(live);
  });
});

describe('isHiddenBypassActorsProblem', () => {
  it('matches only the bypass-actor visibility gap', () => {
    expect(
      isHiddenBypassActorsProblem('ruleset "Protect main": bypass_actors'),
    ).toBe(true);
    expect(
      isHiddenBypassActorsProblem('ruleset "Protect main": conditions'),
    ).toBe(false);
  });
});
