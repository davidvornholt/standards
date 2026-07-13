import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  integrity = await npmIntegrity(artifact);
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

const inspect = (fetcher: ReleaseFetcher) =>
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
    expect(await inspect(fetchJson(metadata()))).toEqual({
      ok: true,
      value: { integrity, publish: false, reconcile: true },
    });
  });

  it('publishes a packed initial artifact after a verified 404', async () => {
    expect(
      await inspectNpmRelease({
        artifact,
        expectedSha: 'expected',
        fetcher: fetchJson({ error: 'Not found' }, HTTP_NOT_FOUND),
        name: '@davidvornholt/new-package',
        parentVersion: null,
        version: '0.1.0',
      }),
    ).toEqual({
      ok: true,
      value: { integrity, publish: true, reconcile: true },
    });
  });

  it('rejects mismatched registry bytes and source metadata', async () => {
    expect(
      await inspect(
        fetchJson(metadata({ dist: { integrity: 'sha512-other' } })),
      ),
    ).toEqual({
      error: `Existing npm artifact integrity sha512-other does not match expected ${integrity}`,
      ok: false,
    });
    expect(await inspect(fetchJson(metadata({ gitHead: 'other' })))).toEqual({
      error:
        'Existing npm artifact gitHead other does not match expected expected',
      ok: false,
    });
  });

  it('fails closed on registry errors and malformed metadata', async () => {
    expect(
      await inspect(fetchJson({ error: 'unavailable' }, HTTP_UNAVAILABLE)),
    ).toEqual({
      error: 'Reading npm metadata: HTTP 503 unavailable',
      ok: false,
    });
    const failingFetch: ReleaseFetcher = () =>
      Promise.reject(new Error('network down'));
    expect(await inspect(failingFetch)).toEqual({
      error: 'Reading npm metadata failed: Error: network down',
      ok: false,
    });
  });
});
