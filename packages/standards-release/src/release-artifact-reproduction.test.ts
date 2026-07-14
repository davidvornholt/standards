import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { authenticatePublishedArtifact } from './release-artifact-reproduction';
import {
  fail,
  flip,
  never,
  runPromise,
  runPromiseExit,
} from './release-effect';
import {
  createReleaseNpmTestFixture,
  type ReleaseNpmTestFixture,
} from './release-npm-test-fixture';
import {
  RELEASE_BUN_VERSION,
  validateReleaseBunVersion,
} from './release-package';
import { ReleasePackageError } from './release-package-error';
import { file } from './release-runtime';

let fixture: ReleaseNpmTestFixture;
const SHA_LENGTH = 40;
const { Glob } = await import('bun');

const temporaryEntries = (directory: string) =>
  Array.fromAsync(new Glob('*').scan({ cwd: directory }));

beforeAll(async () => {
  fixture = await createReleaseNpmTestFixture();
});

afterAll(async () => {
  await fixture.dispose();
});

const authenticate = async (input: {
  readonly candidateSha: string;
  readonly downloadedArtifact?: string;
  readonly expectedIntegrity?: string;
}) => {
  const downloadedBytes = new Uint8Array(
    await file(input.downloadedArtifact ?? fixture.artifact).arrayBuffer(),
  );
  return authenticatePublishedArtifact({
    candidateSha: input.candidateSha,
    currentSha: fixture.currentSha,
    downloadedBytes,
    expectedIntegrity: input.expectedIntegrity ?? fixture.integrity,
    repositoryPath: fixture.repository,
    temporaryDirectory: fixture.temporaryDirectory,
  });
};

describe('published artifact reproduction', () => {
  it('rejects arbitrary bytes that self-assert an innocent ancestor', async () => {
    const failure = await runPromise(
      flip(
        await authenticate({
          candidateSha: fixture.publishedSha,
          downloadedArtifact: fixture.mismatchedArtifact,
          expectedIntegrity: fixture.mismatchedIntegrity,
        }),
      ),
    );
    expect(failure).toMatchObject({
      _tag: 'ArtifactIdentityError',
      message: expect.stringContaining('Reproduced package integrity'),
    });
  });

  it('authenticates an interrupted release from two independent worktrees', async () => {
    expect(
      await Promise.all([
        runPromise(await authenticate({ candidateSha: fixture.publishedSha })),
        runPromise(await authenticate({ candidateSha: fixture.publishedSha })),
      ]),
    ).toEqual([fixture.publishedSha, fixture.publishedSha]);
    expect(await temporaryEntries(fixture.temporaryDirectory)).toEqual([]);
    expect(await file(fixture.scriptSentinel).exists()).toBeFalse();
  });

  it('rejects nonobjects and nonancestors before packing', async () => {
    const downloadedBytes = new Uint8Array(
      await file(fixture.artifact).arrayBuffer(),
    );
    let packCalls = 0;
    const failures = await Promise.all(
      ['f'.repeat(SHA_LENGTH), fixture.nonAncestorSha].map((candidateSha) =>
        runPromise(
          flip(
            authenticatePublishedArtifact({
              candidateSha,
              currentSha: fixture.currentSha,
              downloadedBytes,
              expectedIntegrity: fixture.integrity,
              packArtifact: () => {
                packCalls += 1;
                return fail(
                  new ReleasePackageError({ message: 'must not pack' }),
                );
              },
              repositoryPath: fixture.repository,
              temporaryDirectory: fixture.temporaryDirectory,
            }),
          ),
        ),
      ),
    );
    expect(
      failures.every((failure) => failure._tag === 'ReleaseReproductionError'),
    ).toBeTrue();
    expect(packCalls).toBe(0);
    expect(await temporaryEntries(fixture.temporaryDirectory)).toEqual([]);
  });

  it('cleans the worktree after failure and interruption', async () => {
    const downloadedBytes = new Uint8Array(
      await file(fixture.artifact).arrayBuffer(),
    );
    const base = {
      candidateSha: fixture.publishedSha,
      currentSha: fixture.currentSha,
      downloadedBytes,
      expectedIntegrity: fixture.integrity,
      repositoryPath: fixture.repository,
      temporaryDirectory: fixture.temporaryDirectory,
    };
    await runPromise(
      flip(
        authenticatePublishedArtifact({
          ...base,
          packArtifact: () =>
            fail(new ReleasePackageError({ message: 'pack failed' })),
        }),
      ),
    );
    expect(await temporaryEntries(fixture.temporaryDirectory)).toEqual([]);

    let started = (): void => undefined;
    const packStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const controller = new AbortController();
    const interrupted = runPromiseExit(
      authenticatePublishedArtifact({
        ...base,
        packArtifact: () => {
          started();
          return never;
        },
      }),
      { signal: controller.signal },
    );
    await packStarted;
    controller.abort();
    expect((await interrupted)._tag).toBe('Failure');
    expect(await temporaryEntries(fixture.temporaryDirectory)).toEqual([]);
  });
});

describe('release packer version', () => {
  it('fails closed outside the exact format version', async () => {
    await expect(
      runPromise(validateReleaseBunVersion(RELEASE_BUN_VERSION)),
    ).resolves.toBeUndefined();
    expect(
      await runPromise(flip(validateReleaseBunVersion('1.3.15'))),
    ).toMatchObject({
      _tag: 'ReleasePackageError',
      message: expect.stringContaining('requires Bun 1.3.14'),
    });
  });
});
