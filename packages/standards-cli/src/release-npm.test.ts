import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flip, runPromise } from './release-effect';
import {
  inspectNpmRelease,
  npmIntegrity,
  type ReleaseFetcher,
} from './release-npm';

let directory = '';
let artifact = '';
let integrity = '';
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'release-npm-'));
  artifact = join(directory, 'package.tgz');
  await writeFile(artifact, 'exact package bytes');
  integrity = await runPromise(npmIntegrity(artifact));
});

afterAll(async () => {
  await rm(directory, { force: true, recursive: true });
});

const metadata = (overrides: Record<string, unknown> = {}) => ({
  'dist-tags': { latest: '0.5.0' },
  versions: {
    '0.5.0': {
      dist: { integrity },
      gitHead: 'expected',
      ...overrides,
    },
  },
});

const fetchJson =
  (body: unknown, status = 200): ReleaseFetcher =>
  () =>
    Promise.resolve(Response.json(body, { status }));

const effect = (fetcher: ReleaseFetcher) =>
  inspectNpmRelease({
    artifact,
    expectedSha: 'expected',
    fetcher,
    name: '@davidvornholt/standards',
    parentVersion: '0.4.0',
    version: '0.5.0',
  });

describe('npm release inspection', () => {
  it('accepts matching registry bytes and source metadata', async () => {
    expect(await runPromise(effect(fetchJson(metadata())))).toEqual({
      integrity,
      publish: false,
      reconcile: true,
    });
  });

  it('publishes a packed initial artifact only after package 404', async () => {
    expect(
      await runPromise(
        inspectNpmRelease({
          artifact,
          expectedSha: 'expected',
          fetcher: fetchJson({ error: 'Not found' }, HTTP_NOT_FOUND),
          name: '@davidvornholt/new-package',
          parentVersion: null,
          version: '0.1.0',
        }),
      ),
    ).toEqual({ integrity, publish: true, reconcile: true });
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
            effect(
              fetchJson({
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

  it('rejects mismatched registry bytes and source metadata', async () => {
    const integrityFailure = await runPromise(
      flip(
        effect(fetchJson(metadata({ dist: { integrity: 'sha512-other' } }))),
      ),
    );
    expect(integrityFailure).toMatchObject({
      _tag: 'ArtifactIdentityError',
      message: `Existing npm artifact integrity sha512-other does not match expected ${integrity}`,
    });
    const sourceFailure = await runPromise(
      flip(effect(fetchJson(metadata({ gitHead: 'other' })))),
    );
    expect(sourceFailure).toMatchObject({
      _tag: 'ArtifactIdentityError',
      message:
        'Existing npm artifact gitHead other does not match expected expected',
    });
  });

  it('fails closed on registry and transport errors', async () => {
    const apiFailure = await runPromise(
      flip(effect(fetchJson({ error: 'unavailable' }, HTTP_UNAVAILABLE))),
    );
    expect(apiFailure).toMatchObject({
      _tag: 'NpmRegistryError',
      message: 'Reading npm metadata failed with HTTP 503',
    });
    const failingFetch: ReleaseFetcher = () =>
      Promise.reject(new Error('network down'));
    expect(await runPromise(flip(effect(failingFetch)))).toMatchObject({
      _tag: 'NpmRegistryError',
      message: 'Reading npm metadata failed: Error: network down',
    });
  });
});
