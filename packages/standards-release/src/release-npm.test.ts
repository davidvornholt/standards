import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { flip, runPromise } from './release-effect';
import { inspectNpmRelease, type ReleaseFetcher } from './release-npm';
import {
  createReleaseNpmTestFixture,
  type ReleaseNpmTestFixture,
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
  it('accepts matching registry bytes and source metadata', async () => {
    expect(
      await runPromise(fixture.effect(fixture.fetchJson(fixture.metadata()))),
    ).toEqual({
      integrity: fixture.integrity,
      publish: false,
      reconcile: true,
    });
  });

  it('reconciles an identity-verified historical version behind latest', async () => {
    expect(
      await runPromise(
        fixture.effect(
          fixture.fetchJson(fixture.metadata({ gitHead: undefined }, '0.6.0')),
        ),
      ),
    ).toEqual({
      integrity: fixture.integrity,
      publish: false,
      reconcile: true,
    });
  });

  it('publishes a packed initial artifact only after package 404', async () => {
    expect(
      await runPromise(
        inspectNpmRelease({
          artifact: fixture.artifact,
          expectedSha: 'expected',
          fetcher: fixture.fetchJson({ error: 'Not found' }, HTTP_NOT_FOUND),
          name: '@davidvornholt/new-package',
          parentVersion: null,
          version: '0.1.0',
        }),
      ),
    ).toEqual({ integrity: fixture.integrity, publish: true, reconcile: true });
  });

  it('rejects missing or invalid latest on package metadata 200', async () => {
    const cases = [
      { expectedTag: 'NpmRegistryError', tags: {} },
      { expectedTag: 'NpmRegistryError', tags: { latest: 42 } },
      {
        expectedTag: 'ReleaseValidationError',
        tags: { latest: 'not-semver' },
      },
    ] as const;
    const failures = await Promise.all(
      cases.map(({ tags }) =>
        runPromise(
          flip(
            fixture.effect(
              fixture.fetchJson({
                'dist-tags': tags,
                versions: {},
              }),
            ),
          ),
        ),
      ),
    );
    for (const [index, failure] of failures.entries()) {
      expect(failure).toMatchObject({
        _tag: cases[index]?.expectedTag,
      });
    }
  });

  it('rejects publishing an absent historical version behind latest', async () => {
    expect(
      await runPromise(
        flip(
          fixture.effect(
            fixture.fetchJson({
              'dist-tags': { latest: '0.6.0' },
              versions: {},
            }),
          ),
        ),
      ),
    ).toMatchObject({
      _tag: 'ReleaseValidationError',
      message: 'Manifest version 0.5.0 is behind npm latest 0.6.0',
    });
  });
});

describe('npm artifact identity failures', () => {
  it('rejects mismatched registry bytes and source metadata', async () => {
    const integrityFailure = await runPromise(
      flip(
        fixture.effect(
          fixture.fetchJson(
            fixture.metadata({ dist: { integrity: 'sha512-other' } }),
          ),
        ),
      ),
    );
    expect(integrityFailure).toMatchObject({
      _tag: 'ArtifactIdentityError',
      message: `Existing npm artifact integrity sha512-other does not match expected ${fixture.integrity}`,
    });
    const sourceFailure = await runPromise(
      flip(
        fixture.effect(
          fixture.fetchJson(fixture.metadata({ gitHead: 'other' })),
        ),
      ),
    );
    expect(sourceFailure).toMatchObject({
      _tag: 'ArtifactIdentityError',
      message:
        'Existing npm artifact gitHead other does not match expected expected',
    });
    const markerFailure = await runPromise(
      flip(
        inspectNpmRelease({
          artifact: fixture.artifact,
          expectedSha: 'other',
          fetcher: fixture.fetchJson(fixture.metadata({ gitHead: undefined })),
          name: '@davidvornholt/standards',
          parentVersion: '0.4.0',
          version: '0.5.0',
        }),
      ),
    );
    expect(markerFailure).toMatchObject({
      _tag: 'ArtifactIdentityError',
      message: 'Package source commit expected does not match expected other',
    });
  });

  it('fails closed for a legacy artifact without a source marker', async () => {
    expect(
      await runPromise(
        flip(
          inspectNpmRelease({
            artifact: fixture.unmarkedArtifact,
            expectedSha: 'expected',
            fetcher: fixture.fetchJson(
              fixture.metadata(
                { gitHead: undefined },
                '0.5.0',
                fixture.unmarkedIntegrity,
              ),
            ),
            name: '@davidvornholt/standards',
            parentVersion: '0.4.0',
            version: '0.5.0',
          }),
        ),
      ),
    ).toMatchObject({
      _tag: 'ArtifactIdentityError',
      message: 'Package artifact has no readable package/SOURCE_COMMIT',
    });
  });

  it('fails closed on registry and transport errors', async () => {
    const apiFailure = await runPromise(
      flip(
        fixture.effect(
          fixture.fetchJson({ error: 'unavailable' }, HTTP_UNAVAILABLE),
        ),
      ),
    );
    expect(apiFailure).toMatchObject({
      _tag: 'NpmRegistryError',
      message: 'Reading npm metadata failed with HTTP 503',
    });
    const failingFetch: ReleaseFetcher = () =>
      Promise.reject(new Error('network down'));
    expect(await runPromise(flip(fixture.effect(failingFetch)))).toMatchObject({
      _tag: 'NpmRegistryError',
      message: 'Reading npm metadata failed: Error: network down',
    });
  });
});
