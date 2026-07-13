import { describe, expect, it } from 'bun:test';
import { type Effect, flip, runSync } from './release-effect';
import { decideReconciliation } from './release-state';

const succeed = <A, E>(effect: Effect<A, E>): A => runSync(effect);

const fail = <A, E>(effect: Effect<A, E>): E => runSync(flip(effect));

describe('GitHub reconciliation decisions', () => {
  it('creates absent state and accepts an exact release', () => {
    expect(
      succeed(
        decideReconciliation({
          expectedSha: 'expected',
          releaseStatus: 'absent',
          tagSha: null,
        }),
      ),
    ).toBe('create');
    expect(
      succeed(
        decideReconciliation({
          expectedSha: 'expected',
          releaseStatus: 'published',
          tagSha: 'expected',
        }),
      ),
    ).toBe('exists');
  });

  it('rejects drafts, missing published tags, and wrong tags', () => {
    const inputs = [
      {
        expectedSha: 'expected',
        releaseStatus: 'draft' as const,
        tagSha: 'expected',
      },
      {
        expectedSha: 'expected',
        releaseStatus: 'published' as const,
        tagSha: null,
      },
      {
        expectedSha: 'expected',
        releaseStatus: 'absent' as const,
        tagSha: 'other',
      },
    ];
    for (const input of inputs) {
      expect(fail(decideReconciliation(input))).toMatchObject({
        _tag: 'GithubStateError',
      });
    }
  });
});
