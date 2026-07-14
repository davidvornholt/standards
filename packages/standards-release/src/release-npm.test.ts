import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { flip, runPromise } from './release-effect';
import { inspectNpmRelease, type ReleaseFetcher } from './release-npm';
import {
  CURRENT_SHA,
  createReleaseNpmTestFixture,
  PUBLISHED_SHA,
  type ReleaseNpmTestFixture,
  TARBALL_URL,
} from './release-npm-test-fixture';

let fixture: ReleaseNpmTestFixture;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;

beforeAll(async () => {
  fixture = await createReleaseNpmTestFixture();
});

afterAll(async () => {
  await fixture.dispose();
});

describe('npm release inspection', () => {
  it('verifies an immutable published artifact and returns its source', async () => {
    expect(
      await runPromise(
        fixture.effect(
          fixture.fetchRegistry({ metadataBody: fixture.metadata() }),
        ),
      ),
    ).toEqual({
      publish: false,
      reconcile: true,
      releaseSha: PUBLISHED_SHA,
    });
    expect(
      await runPromise(
        fixture.effect(
          fixture.fetchRegistry({
            metadataBody: fixture.metadata({}, '0.6.0'),
          }),
        ),
      ),
    ).toEqual({
      publish: false,
      reconcile: true,
      releaseSha: PUBLISHED_SHA,
    });
  });

  it('publishes an absent current version regardless of its parent hint', async () => {
    expect(
      await runPromise(
        inspectNpmRelease({
          currentSha: CURRENT_SHA,
          fetcher: fixture.fetchRegistry({
            metadataBody: { error: 'Not found' },
            metadataStatus: HTTP_NOT_FOUND,
          }),
          name: '@davidvornholt/new-package',
          version: '0.5.0',
        }),
      ),
    ).toEqual({
      publish: true,
      reconcile: true,
      releaseSha: CURRENT_SHA,
    });
  });

  it('rejects invalid metadata and an absent version behind latest', async () => {
    const failures = await Promise.all(
      [
        { 'dist-tags': {}, versions: {} },
        { 'dist-tags': { latest: 42 }, versions: {} },
        { 'dist-tags': { latest: 'not-semver' }, versions: {} },
        { 'dist-tags': { latest: '0.6.0' }, versions: {} },
      ].map((metadataBody) =>
        runPromise(
          flip(fixture.effect(fixture.fetchRegistry({ metadataBody }))),
        ),
      ),
    );
    expect(failures.map((failure) => failure._tag)).toEqual([
      'NpmRegistryError',
      'NpmRegistryError',
      'ReleaseValidationError',
      'ReleaseValidationError',
    ]);
  });
});

describe('npm artifact identity failures', () => {
  it('rejects mismatched SRI and legacy artifacts', async () => {
    const cases = [
      {
        fetcher: fixture.fetchRegistry({
          metadataBody: fixture.metadata({
            dist: { integrity: 'sha512-other', tarball: TARBALL_URL },
          }),
        }),
        message: 'does not match expected sha512-other',
      },
      {
        fetcher: fixture.fetchRegistry({
          artifactPath: fixture.unmarkedArtifact,
          metadataBody: fixture.metadata({
            dist: {
              integrity: fixture.unmarkedIntegrity,
              tarball: TARBALL_URL,
            },
          }),
        }),
        message: 'Package artifact has no package/SOURCE_COMMIT',
      },
    ];
    const failures = await Promise.all(
      cases.map((testCase) =>
        runPromise(flip(fixture.effect(testCase.fetcher))),
      ),
    );
    for (const [index, failure] of failures.entries()) {
      expect(failure).toMatchObject({ _tag: 'ArtifactIdentityError' });
      expect(failure.message).toContain(cases[index]?.message ?? 'missing');
    }
    const manifestMismatches = await Promise.all([
      runPromise(
        flip(
          inspectNpmRelease({
            currentSha: CURRENT_SHA,
            fetcher: fixture.fetchRegistry({
              metadataBody: fixture.metadata(),
            }),
            name: '@davidvornholt/other',
            version: '0.5.0',
          }),
        ),
      ),
      runPromise(
        flip(
          inspectNpmRelease({
            currentSha: CURRENT_SHA,
            fetcher: fixture.fetchRegistry({
              metadataBody: fixture.metadata({}, '0.6.0', '0.6.0'),
            }),
            name: '@davidvornholt/standards',
            version: '0.6.0',
          }),
        ),
      ),
    ]);
    expect(
      manifestMismatches.every(
        (failure) => failure._tag === 'ArtifactIdentityError',
      ),
    ).toBeTrue();
  });

  it('fails closed on incomplete metadata, registry, and transport errors', async () => {
    const incomplete = await runPromise(
      flip(
        fixture.effect(
          fixture.fetchRegistry({
            metadataBody: fixture.metadata({ dist: {} }),
          }),
        ),
      ),
    );
    expect(incomplete).toMatchObject({ _tag: 'NpmRegistryError' });
    const unavailable = await runPromise(
      flip(
        fixture.effect(
          fixture.fetchRegistry({
            metadataBody: fixture.metadata(),
            tarballStatus: HTTP_UNAVAILABLE,
          }),
        ),
      ),
    );
    expect(unavailable).toMatchObject({ _tag: 'NpmRegistryError' });
    const failingFetch: ReleaseFetcher = () =>
      Promise.reject(new Error('network down'));
    expect(await runPromise(flip(fixture.effect(failingFetch)))).toMatchObject({
      _tag: 'NpmRegistryError',
      message: 'Reading npm metadata failed: Error: network down',
    });
  });
});
