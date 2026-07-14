import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'bun';
import { runPromise } from './release-effect';
import { inspectNpmRelease } from './release-npm';
import {
  createReleaseNpmTestFixture,
  type ReleaseNpmTestFixture,
} from './release-npm-test-fixture';

let fixture: ReleaseNpmTestFixture;
const HTTP_NOT_FOUND = 404;

beforeAll(async () => {
  fixture = await createReleaseNpmTestFixture();
});

afterAll(async () => {
  await fixture.dispose();
});

describe('npm first-publish retry identity', () => {
  it('accepts retry identity after rewriting a stale caller gitHead', async () => {
    expect(
      JSON.parse(
        spawnSync([
          'tar',
          '-xOzf',
          fixture.artifact,
          'package/package.json',
        ]).stdout.toString(),
      ),
    ).toMatchObject({ gitHead: 'expected' });
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
    ).toEqual({
      integrity: fixture.integrity,
      publish: true,
      reconcile: true,
    });
    expect(
      await runPromise(fixture.effect(fixture.fetchJson(fixture.metadata()))),
    ).toEqual({
      integrity: fixture.integrity,
      publish: false,
      reconcile: true,
    });
  });
});
