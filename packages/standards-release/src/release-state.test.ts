import { describe, expect, it } from 'bun:test';
import { type Effect, flip, runSync } from './release-effect';
import { decideRelease } from './release-state';

const succeed = <A, E>(effect: Effect<A, E>): A => runSync(effect);
const fail = <A, E>(effect: Effect<A, E>): E => runSync(flip(effect));

describe('release planning', () => {
  it('publishes an absent current version and reconciles an existing one', () => {
    expect(
      succeed(
        decideRelease({
          npmLatest: '0.4.0',
          npmVersionExists: false,
          version: '0.5.0',
        }),
      ),
    ).toEqual({ publish: true, reconcile: true });
    expect(
      succeed(
        decideRelease({
          npmLatest: '0.5.0',
          npmVersionExists: true,
          version: '0.5.0',
        }),
      ),
    ).toEqual({ publish: false, reconcile: true });
  });

  it('validates current SemVer without a parent gate', () => {
    expect(
      fail(
        decideRelease({
          npmLatest: null,
          npmVersionExists: false,
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
          version: '0.1.0',
        }),
      ),
    ).toEqual({ publish: true, reconcile: true });
  });

  it('compares arbitrary-size registry versions exactly', () => {
    expect(
      succeed(
        decideRelease({
          npmLatest: '9007199254740992.0.0',
          npmVersionExists: false,
          version: '9007199254740993.0.0',
        }),
      ),
    ).toEqual({ publish: true, reconcile: true });
    expect(
      fail(
        decideRelease({
          npmLatest: '999999999999999999999999999999.2.0',
          npmVersionExists: false,
          version: '999999999999999999999999999999.1.0',
        }),
      ),
    ).toMatchObject({ _tag: 'ReleaseValidationError' });
  });

  it('fails closed for unpublished regressions and malformed npm latest', () => {
    expect(
      fail(
        decideRelease({
          npmLatest: '0.6.0',
          npmVersionExists: false,
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
          version: '0.5.0',
        }),
      ),
    ).toMatchObject({ _tag: 'ReleaseValidationError' });
  });
});
