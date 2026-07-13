import { ArtifactIdentityError } from './artifact-identity-error';
import { fail, flatMap, gen, succeed, tryPromise } from './release-effect';
import { ReleasePackageError } from './release-package-error';
import { argv, file, spawn, write } from './release-runtime';

export const SOURCE_COMMIT_FILE = 'SOURCE_COMMIT';
const ARCHIVE_SOURCE_COMMIT = `package/${SOURCE_COMMIT_FILE}`;

type CommandResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

const run = (command: ReadonlyArray<string>): Promise<CommandResult> => {
  const subprocess = spawn([...command], { stderr: 'pipe', stdout: 'pipe' });
  return Promise.all([
    subprocess.exited,
    new Response(subprocess.stderr).text(),
    new Response(subprocess.stdout).text(),
  ]).then(([exitCode, stderr, stdout]) => ({ exitCode, stderr, stdout }));
};

const requireMissingMarker = (marker: string): Promise<void> =>
  file(marker)
    .exists()
    .then((exists) =>
      exists
        ? Promise.reject(
            new Error(`${marker} already exists; refusing to overwrite it`),
          )
        : undefined,
    );

const packGeneratedMarker = (
  marker: string,
  input: {
    readonly destination: string;
    readonly expectedSha: string;
    readonly packagePath: string;
  },
): Promise<CommandResult> =>
  write(marker, `${input.expectedSha}\n`)
    .then(() =>
      run([
        argv[0] ?? 'bun',
        'pm',
        'pack',
        '--cwd',
        input.packagePath,
        '--destination',
        input.destination,
        '--ignore-scripts',
        '--quiet',
      ]),
    )
    .finally(() => file(marker).delete());

export const verifyArtifactSourceCommit = (input: {
  readonly artifact: string;
  readonly expectedSha: string;
}) =>
  tryPromise({
    try: () => run(['tar', '-xOzf', input.artifact, ARCHIVE_SOURCE_COMMIT]),
    catch: (cause) =>
      new ArtifactIdentityError({
        message: `Reading package source commit failed: ${String(cause)}`,
      }),
  }).pipe(
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
  return tryPromise({
    try: () =>
      requireMissingMarker(marker).then(() =>
        packGeneratedMarker(marker, input),
      ),
    catch: (cause) =>
      new ReleasePackageError({
        message: `Packing release artifact failed: ${String(cause)}`,
      }),
  }).pipe(
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
