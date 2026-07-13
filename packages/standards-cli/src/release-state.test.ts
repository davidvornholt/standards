import { describe, expect, it } from 'bun:test';
import { type Effect, flip, runSync } from './release-effect';
import {
  classifyReleaseDeclaration,
  decideRelease,
  verifyArtifactIdentity,
} from './release-state';

const succeed = <A, E>(effect: Effect<A, E>): A => runSync(effect);

const fail = <A, E>(effect: Effect<A, E>): E => runSync(flip(effect));

describe('release planning', () => {
  it('publishes a new declaration and reconciles an existing one', () => {
    expect(
      succeed(
        decideRelease({
          npmLatest: '0.4.0',
          npmVersionExists: false,
          parentVersion: '0.4.0',
          version: '0.5.0',
        }),
      ),
    ).toEqual({ publish: true, reconcile: true });
    expect(
      succeed(
        decideRelease({
          npmLatest: '0.5.0',
          npmVersionExists: true,
          parentVersion: '0.4.0',
          version: '0.5.0',
        }),
      ),
    ).toEqual({ publish: false, reconcile: true });
  });

  it('recovers initial, moved, and invalid-parent declarations', () => {
    for (const parentVersion of [null, 'not-semver']) {
      expect(
        succeed(
          decideRelease({
            npmLatest: '0.5.0',
            npmVersionExists: true,
            parentVersion,
            version: '0.5.0',
          }),
        ),
      ).toEqual({ publish: false, reconcile: true });
    }
    expect(
      succeed(
        decideRelease({
          npmLatest: null,
          npmVersionExists: false,
          parentVersion: null,
          version: '0.1.0',
        }),
      ),
    ).toEqual({ publish: true, reconcile: true });
  });

  it('validates current SemVer before unchanged no-op', () => {
    expect(
      fail(
        classifyReleaseDeclaration({
          parentVersion: 'not-semver',
          version: 'not-semver',
        }),
      ),
    ).toMatchObject({
      _tag: 'ReleaseValidationError',
      message: 'Version not-semver must be a stable SemVer',
    });
    expect(
      succeed(
        decideRelease({
          npmLatest: null,
          npmVersionExists: false,
          parentVersion: '0.5.0',
          version: '0.5.0',
        }),
      ),
    ).toEqual({ publish: false, reconcile: false });
  });

  it('compares arbitrary-size SemVer components exactly', () => {
    expect(
      succeed(
        classifyReleaseDeclaration({
          parentVersion: '9007199254740992.0.0',
          version: '9007199254740993.0.0',
        }),
      ),
    ).toBeTrue();
    expect(
      succeed(
        classifyReleaseDeclaration({
          parentVersion: '999999999999999999999999999999.1.0',
          version: '999999999999999999999999999999.2.0',
        }),
      ),
    ).toBeTrue();
  });

  it('fails closed for regressions and malformed npm latest', () => {
    expect(
      fail(
        decideRelease({
          npmLatest: '0.6.0',
          npmVersionExists: false,
          parentVersion: null,
          version: '0.5.0',
        }),
      ),
    ).toMatchObject({
      _tag: 'ReleaseValidationError',
      message: 'Manifest version 0.5.0 is behind npm latest 0.6.0',
    });
    expect(
      fail(
        decideRelease({
          npmLatest: 'invalid',
          npmVersionExists: false,
          parentVersion: null,
          version: '0.5.0',
        }),
      ),
    ).toMatchObject({ _tag: 'ReleaseValidationError' });
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

  it('accepts matching or absent artifacts', () => {
    expect(succeed(verifyArtifactIdentity(matching))).toBeUndefined();
    expect(
      succeed(
        verifyArtifactIdentity({
          ...matching,
          npmGitHead: null,
          npmIntegrity: null,
          npmVersionExists: false,
        }),
      ),
    ).toBeUndefined();
  });

  it('rejects unknown, mismatched, or wrong-source artifacts', () => {
    expect(
      fail(verifyArtifactIdentity({ ...matching, npmIntegrity: null })),
    ).toMatchObject({ _tag: 'ArtifactIdentityError' });
    expect(
      fail(
        verifyArtifactIdentity({ ...matching, npmIntegrity: 'sha512-other' }),
      ),
    ).toMatchObject({ _tag: 'ArtifactIdentityError' });
    expect(
      fail(verifyArtifactIdentity({ ...matching, npmGitHead: 'other' })),
    ).toMatchObject({ _tag: 'ArtifactIdentityError' });
  });
});
