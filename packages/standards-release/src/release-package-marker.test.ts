import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'bun';
import { fail, flatMap, flip, runPromise, succeed } from './release-effect';
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
  it('does not release a marker whose exclusive open failed', async () => {
    const openFailure = new ReleasePackageError({
      message: 'marker open failed',
    });
    let removalAttempts = 0;
    const operations: MarkerOperations = {
      ...markerOperations,
      open: () => fail(openFailure),
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
    expect(failure).toBe(openFailure);
    expect(removalAttempts).toBe(0);
  });

  it('removes its marker and closes after a post-open write failure', async () => {
    const marker = `${temporaryDirectory()}/SOURCE_COMMIT`;
    const writeFailure = new ReleasePackageError({
      message: 'marker write failed',
    });
    let closeAttempts = 0;
    let removalAttempts = 0;
    let operationAttempts = 0;
    const failure = await runPromise(
      flip(
        withGeneratedMarkerOperations(
          marker,
          'sha\n',
          () => {
            operationAttempts += 1;
            return succeed(undefined);
          },
          {
            ...markerOperations,
            close: (ownership) => {
              closeAttempts += 1;
              return markerOperations.close(ownership);
            },
            remove: (ownership, identity) => {
              removalAttempts += 1;
              return markerOperations.remove(ownership, identity);
            },
            write: () => fail(writeFailure),
          },
        ),
      ),
    );
    expect(failure).toBe(writeFailure);
    expect(closeAttempts).toBe(1);
    expect(removalAttempts).toBe(1);
    expect(operationAttempts).toBe(0);
    expect(await file(marker).exists()).toBe(false);
  });
});

describe('release package marker finalization', () => {
  it('removes its marker and returns a close failure after the use phase', async () => {
    const marker = `${temporaryDirectory()}/SOURCE_COMMIT`;
    const closeFailure = new ReleasePackageError({
      message: 'marker close failed',
    });
    const events: Array<string> = [];
    let operationAttempts = 0;
    const failure = await runPromise(
      flip(
        withGeneratedMarkerOperations(
          marker,
          'sha\n',
          () => {
            operationAttempts += 1;
            events.push('use');
            return succeed(undefined);
          },
          {
            ...markerOperations,
            close: (ownership) =>
              succeed(undefined).pipe(
                flatMap(() => {
                  events.push('close');
                  return markerOperations.close(ownership);
                }),
                flatMap(() => fail(closeFailure)),
              ),
            remove: (ownership, identity) => {
              events.push('cleanup');
              return markerOperations.remove(ownership, identity);
            },
          },
        ),
      ),
    );
    expect(failure).toBe(closeFailure);
    expect(operationAttempts).toBe(1);
    expect(events).toEqual(['use', 'cleanup', 'close']);
    expect(await file(marker).exists()).toBe(false);
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
