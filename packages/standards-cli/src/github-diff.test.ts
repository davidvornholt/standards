import { describe, expect, it } from 'bun:test';
import { diffRepositorySettings, subsetMatches } from './github-diff';

describe('subsetMatches', () => {
  it('ignores extra keys on the live side', () => {
    expect(subsetMatches({ a: 1 }, { a: 1, b: 2 })).toBe(true);
  });

  it('rejects a changed nested value', () => {
    expect(subsetMatches({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
  });

  it('matches arrays regardless of order but not length', () => {
    expect(subsetMatches(['squash', 'rebase'], ['rebase', 'squash'])).toBe(
      true,
    );
    expect(subsetMatches([], ['added'])).toBe(false);
    expect(subsetMatches(['squash'], ['squash', 'rebase'])).toBe(false);
  });
});

describe('diffRepositorySettings', () => {
  it('separates drifted from unverifiable settings', () => {
    const declared = { allow_auto_merge: true, delete_branch_on_merge: true };
    const live = { allow_auto_merge: false };
    const diff = diffRepositorySettings(declared, live);
    expect(diff.drifted).toEqual([
      'repository setting "allow_auto_merge" is false on GitHub, declared true',
    ]);
    expect(diff.unverifiable).toEqual(['delete_branch_on_merge']);
  });
});
