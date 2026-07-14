import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'bun';
import {
  causeFailures,
  fail,
  flip,
  runPromise,
  runPromiseExit,
  succeed,
} from './release-effect';
import { ReleasePackageError } from './release-package-error';
import {
  type MarkerOperations,
  markerOperations,
  withGeneratedMarkerOperations,
} from './release-package-marker';
import { file } from './release-runtime';

const directories: Array<string> = [];

const temporaryDirectory = (): string => {
  const directory = spawnSync(['mktemp', '-d', '/tmp/release-marker-XXXXXX'])
    .stdout.toString()
    .trim();
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    spawnSync(['rm', '-rf', directory]);
  }
});

describe('release package marker lifecycle', () => {
  it('does not release a marker whose creation failed', async () => {
    const creationFailure = new ReleasePackageError({
      message: 'marker creation failed',
    });
    let removalAttempts = 0;
    const operations: MarkerOperations = {
      create: () => fail(creationFailure),
      remove: () => {
        removalAttempts += 1;
        return succeed(undefined);
      },
    };
    const failure = await runPromise(
      flip(
        withGeneratedMarkerOperations(
          '/missing/SOURCE_COMMIT',
          'sha\n',
          () => succeed(undefined),
          operations,
        ),
      ),
    );
    expect(failure).toBe(creationFailure);
    expect(removalAttempts).toBe(0);
  });

  it('returns marker deletion failure through the typed channel', async () => {
    const marker = `${temporaryDirectory()}/SOURCE_COMMIT`;
    const deletionFailure = new ReleasePackageError({
      message: 'marker deletion failed',
    });
    const failure = await runPromise(
      flip(
        withGeneratedMarkerOperations(
          marker,
          'sha\n',
          () => succeed(undefined),
          {
            ...markerOperations,
            remove: () => fail(deletionFailure),
          },
        ),
      ),
    );
    expect(failure).toBe(deletionFailure);
    expect(await file(marker).text()).toBe('sha\n');
  });
});

describe('release package marker failure composition', () => {
  it('retains operation and cleanup failures in sequence', async () => {
    const operationFailure = new ReleasePackageError({
      message: 'packing failed',
    });
    const cleanupFailure = new ReleasePackageError({
      message: 'cleanup failed',
    });
    const outcome = await runPromiseExit(
      withGeneratedMarkerOperations(
        'SOURCE_COMMIT',
        'sha\n',
        () => fail(operationFailure),
        {
          create: () => succeed('SOURCE_COMMIT'),
          remove: () => fail(cleanupFailure),
        },
      ),
    );
    const failures =
      outcome._tag === 'Failure' ? [...causeFailures(outcome.cause)] : [];
    expect(outcome._tag).toBe('Failure');
    expect(failures).toEqual([operationFailure, cleanupFailure]);
  });
});
