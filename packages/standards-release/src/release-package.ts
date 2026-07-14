import { ArtifactIdentityError } from './artifact-identity-error';
import {
  acquireUseRelease,
  all,
  effectTry,
  fail,
  flatMap,
  gen,
  orDie,
  succeed,
  tryPromise,
} from './release-effect';
import { ReleasePackageError } from './release-package-error';
import { argv, file, spawn, write } from './release-runtime';

export const SOURCE_COMMIT_FILE = 'SOURCE_COMMIT';
const ARCHIVE_SOURCE_COMMIT = `package/${SOURCE_COMMIT_FILE}`;

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

const requireMissingMarker = (marker: string) =>
  tryPromise({
    try: () => file(marker).exists(),
    catch: (cause) =>
      releasePackageOperationError('checking the source marker', cause),
  }).pipe(
    flatMap((exists) =>
      exists
        ? fail(
            new ReleasePackageError({
              message: `${marker} already exists; refusing to overwrite it`,
            }),
          )
        : succeed(marker),
    ),
  );

const writeMarker = (marker: string, expectedSha: string) =>
  tryPromise({
    try: () => write(marker, `${expectedSha}\n`),
    catch: (cause) =>
      releasePackageOperationError('writing the source marker', cause),
  });

const deleteMarker = (marker: string) =>
  tryPromise({
    try: () => file(marker).delete(),
    catch: (cause) =>
      releasePackageOperationError('cleaning the source marker', cause),
  });

const packGeneratedMarker = (
  marker: string,
  input: {
    readonly destination: string;
    readonly expectedSha: string;
    readonly packagePath: string;
  },
) =>
  acquireUseRelease(
    requireMissingMarker(marker),
    () =>
      gen(function* () {
        yield* writeMarker(marker, input.expectedSha);
        return yield* run(
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
        );
      }),
    (ownedMarker) => deleteMarker(ownedMarker).pipe(orDie),
  );

export const verifyArtifactSourceCommit = (input: {
  readonly artifact: string;
  readonly expectedSha: string;
}) =>
  run(
    ['tar', '-xOzf', input.artifact, ARCHIVE_SOURCE_COMMIT],
    (operation, cause) =>
      new ArtifactIdentityError({
        message: `Reading package source commit failed while ${operation}: ${String(cause)}`,
      }),
  ).pipe(
    flatMap((result) => {
      if (result.exitCode !== 0) {
        return fail(
          new ArtifactIdentityError({
            message: `Package artifact has no readable ${ARCHIVE_SOURCE_COMMIT}`,
          }),
        );
      }
      const actualSha = result.stdout.trim();
      return actualSha === input.expectedSha
        ? succeed(undefined)
        : fail(
            new ArtifactIdentityError({
              message: `Package source commit ${actualSha || 'empty'} does not match expected ${input.expectedSha}`,
            }),
          );
    }),
  );

const packWithMarker = (input: {
  readonly destination: string;
  readonly expectedSha: string;
  readonly packagePath: string;
}) => {
  const marker = `${input.packagePath}/${SOURCE_COMMIT_FILE}`;
  return packGeneratedMarker(marker, input).pipe(
    flatMap((result) => {
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
    }),
  );
};

export const packReleaseArtifact = (input: {
  readonly destination: string;
  readonly expectedSha: string;
  readonly packagePath: string;
}) =>
  gen(function* () {
    const artifact = yield* packWithMarker(input);
    yield* verifyArtifactSourceCommit({
      artifact,
      expectedSha: input.expectedSha,
    });
    return artifact;
  });
