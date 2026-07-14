import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'bun';
import { runPromise } from './release-effect';
import { inspectNpmRelease } from './release-npm';
import {
  CURRENT_SHA,
  createReleaseNpmTestFixture,
  PUBLISHED_SHA,
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

describe('npm release recovery', () => {
  it('recovers a failed or coalesced bump from the next tested commit', async () => {
    const plan = await runPromise(
      inspectNpmRelease({
        currentSha: CURRENT_SHA,
        fetcher: fixture.fetchRegistry({
          metadataBody: { error: 'Not found' },
          metadataStatus: HTTP_NOT_FOUND,
        }),
        name: '@davidvornholt/standards',
        version: '0.5.0',
      }),
    );
    expect(plan).toEqual({
      publish: true,
      reconcile: true,
      releaseSha: CURRENT_SHA,
    });
  });

  it('reconciles npm-success/GitHub-failure to the published source', async () => {
    expect(
      JSON.parse(
        spawnSync([
          'tar',
          '-xOzf',
          fixture.artifact,
          'package/package.json',
        ]).stdout.toString(),
      ),
    ).toMatchObject({ gitHead: PUBLISHED_SHA });
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
  });
});
