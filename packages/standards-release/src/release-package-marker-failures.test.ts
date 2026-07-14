import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'bun';
import {
  causeFailures,
  fail,
  flatMap,
  runPromiseExit,
  succeed,
} from './release-effect';
import { ReleasePackageError } from './release-package-error';
import {
  markerOperations,
  withGeneratedMarkerOperations,
} from './release-package-marker';
import { file } from './release-runtime';

const directories: Array<string> = [];

const temporaryMarker = (): string => {
  const directory = spawnSync(['mktemp', '-d', '/tmp/release-marker-XXXXXX'])
    .stdout.toString()
    .trim();
  directories.push(directory);
  return `${directory}/SOURCE_COMMIT`;
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    spawnSync(['rm', '-rf', directory]);
  }
});

describe('release package marker failure composition', () => {
  it('retains write, close, and cleanup failures in sequence', async () => {
    const marker = temporaryMarker();
    const writeFailure = new ReleasePackageError({
      message: 'marker write failed',
    });
    const closeFailure = new ReleasePackageError({
      message: 'marker close failed',
    });
    const cleanupFailure = new ReleasePackageError({
      message: 'marker cleanup failed',
    });
    const outcome = await runPromiseExit(
      withGeneratedMarkerOperations(marker, 'sha\n', () => succeed(undefined), {
        ...markerOperations,
        close: (ownership) =>
          markerOperations
            .close(ownership)
            .pipe(flatMap(() => fail(closeFailure))),
        remove: () => fail(cleanupFailure),
        write: () => fail(writeFailure),
      }),
    );
    const failures =
      outcome._tag === 'Failure' ? [...causeFailures(outcome.cause)] : [];
    expect(outcome._tag).toBe('Failure');
    expect(failures).toEqual([writeFailure, closeFailure, cleanupFailure]);
    expect(await file(marker).exists()).toBe(true);
  });

  it('retains operation and cleanup failures in sequence', async () => {
    const operationFailure = new ReleasePackageError({
      message: 'packing failed',
    });
    const cleanupFailure = new ReleasePackageError({
      message: 'cleanup failed',
    });
    const outcome = await runPromiseExit(
      withGeneratedMarkerOperations(
        temporaryMarker(),
        'sha\n',
        () => fail(operationFailure),
        {
          ...markerOperations,
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
