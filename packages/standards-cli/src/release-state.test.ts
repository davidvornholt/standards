import { describe, expect, it } from 'bun:test';
import { decideReconciliation, decideRelease } from './release-state';

describe('release state', () => {
  it('publishes and reconciles a newly declared version absent from npm', () => {
    expect(
      decideRelease({
        npmLatest: '0.4.0',
        npmVersionExists: false,
        parentVersion: '0.4.0',
        version: '0.5.0',
      }),
    ).toEqual({ ok: true, value: { publish: true, reconcile: true } });
    expect(
      decideReconciliation({
        expectedSha: 'expected',
        releaseStatus: 'absent',
        tagSha: null,
      }),
    ).toEqual({ ok: true, value: 'create' });
  });

  it('reconciles a declared version already present on npm', () => {
    expect(
      decideRelease({
        npmLatest: '0.5.0',
        npmVersionExists: true,
        parentVersion: '0.4.0',
        version: '0.5.0',
      }),
    ).toEqual({ ok: true, value: { publish: false, reconcile: true } });
    expect(
      decideReconciliation({
        expectedSha: 'expected',
        releaseStatus: 'absent',
        tagSha: null,
      }),
    ).toEqual({ ok: true, value: 'create' });
  });

  it('fails closed for conflicting release state', () => {
    expect(
      decideReconciliation({
        expectedSha: 'expected',
        releaseStatus: 'absent',
        tagSha: 'other',
      }),
    ).toEqual({
      error: 'Release tag points to other, expected expected',
      ok: false,
    });
    expect(
      decideReconciliation({
        expectedSha: 'expected',
        releaseStatus: 'draft',
        tagSha: 'expected',
      }),
    ).toEqual({ error: 'Release already exists as a draft', ok: false });
  });

  it('does nothing on a later commit with an unchanged version', () => {
    expect(
      decideRelease({
        npmLatest: null,
        npmVersionExists: false,
        parentVersion: '0.5.0',
        version: '0.5.0',
      }),
    ).toEqual({ ok: true, value: { publish: false, reconcile: false } });
  });
});
