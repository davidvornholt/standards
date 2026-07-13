import { describe, expect, it } from 'bun:test';
import {
  classifyReleaseDeclaration,
  decideArtifactIdentity,
  decideReconciliation,
  decideRelease,
} from './release-state';

describe('release planning', () => {
  it('publishes a new declaration and reconciles an existing one', () => {
    expect(
      decideRelease({
        npmLatest: '0.4.0',
        npmVersionExists: false,
        parentVersion: '0.4.0',
        version: '0.5.0',
      }),
    ).toEqual({ ok: true, value: { publish: true, reconcile: true } });
    expect(
      decideRelease({
        npmLatest: '0.5.0',
        npmVersionExists: true,
        parentVersion: '0.4.0',
        version: '0.5.0',
      }),
    ).toEqual({ ok: true, value: { publish: false, reconcile: true } });
  });

  it('treats initial, moved, and invalid-parent declarations as recoverable', () => {
    for (const parentVersion of [null, 'not-semver']) {
      expect(
        decideRelease({
          npmLatest: '0.5.0',
          npmVersionExists: true,
          parentVersion,
          version: '0.5.0',
        }),
      ).toEqual({ ok: true, value: { publish: false, reconcile: true } });
    }
    expect(
      decideRelease({
        npmLatest: null,
        npmVersionExists: false,
        parentVersion: null,
        version: '0.1.0',
      }),
    ).toEqual({ ok: true, value: { publish: true, reconcile: true } });
  });

  it('validates current stable SemVer before an unchanged no-op', () => {
    expect(
      classifyReleaseDeclaration({
        parentVersion: 'not-semver',
        version: 'not-semver',
      }),
    ).toEqual({
      error: 'Version not-semver must be a stable SemVer',
      ok: false,
    });
    expect(
      decideRelease({
        npmLatest: null,
        npmVersionExists: false,
        parentVersion: 'not-semver',
        version: 'not-semver',
      }),
    ).toEqual({
      error: 'Version not-semver must be a stable SemVer',
      ok: false,
    });
    expect(
      decideRelease({
        npmLatest: null,
        npmVersionExists: false,
        parentVersion: '0.5.0',
        version: '0.5.0',
      }),
    ).toEqual({ ok: true, value: { publish: false, reconcile: false } });
  });

  it('fails closed for regressions and inconsistent npm metadata', () => {
    expect(
      decideRelease({
        npmLatest: '0.6.0',
        npmVersionExists: false,
        parentVersion: null,
        version: '0.5.0',
      }),
    ).toEqual({
      error: 'Manifest version 0.5.0 is behind npm latest 0.6.0',
      ok: false,
    });
    expect(
      decideRelease({
        npmLatest: null,
        npmVersionExists: true,
        parentVersion: null,
        version: '0.5.0',
      }),
    ).toEqual({
      error:
        'npm reports the declared version without an authoritative latest version',
      ok: false,
    });
  });
});

describe('artifact identity', () => {
  const matching = {
    expectedIntegrity: 'sha512-expected',
    expectedSha: 'expected',
    npmGitHead: 'expected',
    npmIntegrity: 'sha512-expected',
    npmVersionExists: true,
  } as const;

  it('accepts a matching existing artifact and absent new artifact', () => {
    expect(decideArtifactIdentity(matching)).toEqual({ ok: true, value: true });
    expect(
      decideArtifactIdentity({
        ...matching,
        npmGitHead: null,
        npmIntegrity: null,
        npmVersionExists: false,
      }),
    ).toEqual({ ok: true, value: true });
  });

  it('rejects unknown, mismatched, or wrong-source existing artifacts', () => {
    expect(decideArtifactIdentity({ ...matching, npmIntegrity: null })).toEqual(
      { error: 'Existing npm version has no dist.integrity', ok: false },
    );
    expect(
      decideArtifactIdentity({ ...matching, npmIntegrity: 'sha512-other' }),
    ).toEqual({
      error:
        'Existing npm artifact integrity sha512-other does not match expected sha512-expected',
      ok: false,
    });
    expect(
      decideArtifactIdentity({ ...matching, npmGitHead: 'other' }),
    ).toEqual({
      error:
        'Existing npm artifact gitHead other does not match expected expected',
      ok: false,
    });
  });
});

describe('GitHub reconciliation decisions', () => {
  it('creates absent state and accepts an exact published release', () => {
    expect(
      decideReconciliation({
        expectedSha: 'expected',
        releaseStatus: 'absent',
        tagSha: null,
      }),
    ).toEqual({ ok: true, value: 'create' });
    expect(
      decideReconciliation({
        expectedSha: 'expected',
        releaseStatus: 'published',
        tagSha: 'expected',
      }),
    ).toEqual({ ok: true, value: 'exists' });
  });

  it('rejects drafts, missing published tags, and wrong-SHA tags', () => {
    expect(
      decideReconciliation({
        expectedSha: 'expected',
        releaseStatus: 'draft',
        tagSha: 'expected',
      }),
    ).toEqual({ error: 'Release already exists as a draft', ok: false });
    expect(
      decideReconciliation({
        expectedSha: 'expected',
        releaseStatus: 'published',
        tagSha: null,
      }),
    ).toEqual({
      error: 'Published release has no matching remote tag',
      ok: false,
    });
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
  });
});
