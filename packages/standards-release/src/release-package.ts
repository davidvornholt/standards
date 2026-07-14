import {
  all,
  effectTry,
  either,
  fail,
  flatMap,
  gen,
  isLeft,
  succeed,
  tryPromise,
} from './release-effect';
import { ReleasePackageError } from './release-package-error';
import { rewritePackedArtifact } from './release-package-rewrite';
import {
  argv,
  version as bunVersion,
  nodeLstat,
  spawn,
} from './release-runtime';

export const SOURCE_COMMIT_FILE = 'SOURCE_COMMIT';
export const RELEASE_BUN_VERSION = '1.3.14';

export const validateReleaseBunVersion = (actualVersion: string) =>
  actualVersion === RELEASE_BUN_VERSION
    ? succeed(undefined)
    : fail(
        new ReleasePackageError({
          message: `Packing release artifact requires Bun ${RELEASE_BUN_VERSION}; received ${actualVersion}`,
        }),
      );

type CommandResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

type OperationError<E> = (operation: string, cause: unknown) => E;

const run = <E>(
  command: ReadonlyArray<string>,
  operationError: OperationError<E>,
) =>
  gen(function* () {
    const subprocess = yield* effectTry({
      try: () => spawn([...command], { stderr: 'pipe', stdout: 'pipe' }),
      catch: (cause) => operationError('starting subprocess', cause),
    });
    const [exitCode, stderr, stdout] = yield* all(
      [
        tryPromise({
          try: () => subprocess.exited,
          catch: (cause) => operationError('waiting for subprocess', cause),
        }),
        tryPromise({
          try: () => new Response(subprocess.stderr).text(),
          catch: (cause) => operationError('reading subprocess stderr', cause),
        }),
        tryPromise({
          try: () => new Response(subprocess.stdout).text(),
          catch: (cause) => operationError('reading subprocess stdout', cause),
        }),
      ] as const,
      { concurrency: 'unbounded' },
    );
    return { exitCode, stderr, stdout } satisfies CommandResult;
  });

const releasePackageOperationError: OperationError<ReleasePackageError> = (
  operation,
  cause,
) =>
  new ReleasePackageError({
    message: `Packing release artifact failed while ${operation}: ${String(cause)}`,
  });

type ReleasePackageInput = {
  readonly destination: string;
  readonly expectedSha: string;
  readonly packagePath: string;
};

const ensureSourceMarkerAbsent = (packagePath: string) => {
  const marker = `${packagePath}/${SOURCE_COMMIT_FILE}`;
  return tryPromise({
    try: () => nodeLstat(marker),
    catch: (cause) => cause,
  }).pipe(
    either,
    flatMap((result) => {
      if (!isLeft(result)) {
        return fail(
          new ReleasePackageError({
            message: `Packing release artifact refused caller-owned source marker ${marker}`,
          }),
        );
      }
      const cause = result.left;
      if (
        typeof cause === 'object' &&
        cause !== null &&
        'code' in cause &&
        cause.code === 'ENOENT'
      ) {
        return succeed(undefined);
      }
      return fail(
        releasePackageOperationError(
          'inspecting the source package marker',
          cause,
        ),
      );
    }),
  );
};

const artifactFromResult = (result: CommandResult) => {
  if (result.exitCode !== 0) {
    return fail(
      new ReleasePackageError({
        message: `Packing release artifact failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      }),
    );
  }
  const artifact = result.stdout.trim();
  return artifact === '' || artifact.includes('\n')
    ? fail(
        new ReleasePackageError({
          message: 'Packing release artifact returned an invalid path',
        }),
      )
    : succeed(artifact);
};

export const packReleaseArtifact = (input: ReleasePackageInput) =>
  gen(function* () {
    yield* validateReleaseBunVersion(bunVersion);
    yield* ensureSourceMarkerAbsent(input.packagePath);
    const artifact = yield* run(
      [
        argv[0] ?? 'bun',
        'pm',
        'pack',
        '--cwd',
        input.packagePath,
        '--destination',
        input.destination,
        '--ignore-scripts',
        '--quiet',
      ],
      releasePackageOperationError,
    ).pipe(flatMap(artifactFromResult));
    yield* rewritePackedArtifact({
      artifact,
      expectedSha: input.expectedSha,
    });
    return artifact;
  });
