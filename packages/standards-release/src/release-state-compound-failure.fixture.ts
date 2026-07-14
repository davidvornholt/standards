import { isFailure } from 'effect/Exit';
import { renderReleaseCause } from './release-cause-output';
import { fail, runPromiseExit } from './release-effect';
import { ReleasePackageError } from './release-package-error';
import {
  markerOperations,
  withGeneratedMarkerOperations,
} from './release-package-marker';
import { argv, runtimeProcess, stderr, write } from './release-runtime';

const marker = argv[2] ?? 'SOURCE_COMMIT';
const outcome = await runPromiseExit(
  withGeneratedMarkerOperations(
    marker,
    'sha\n',
    () =>
      fail(
        new ReleasePackageError({
          message: 'packing failed%\ncontinued',
        }),
      ),
    {
      ...markerOperations,
      remove: () =>
        fail(
          new ReleasePackageError({
            message: 'cleanup failed\rnext',
          }),
        ),
    },
  ),
);

if (isFailure(outcome)) {
  await write(stderr, renderReleaseCause(outcome.cause));
  runtimeProcess.exitCode = 1;
}
