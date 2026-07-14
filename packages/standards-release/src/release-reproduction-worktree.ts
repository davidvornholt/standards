import { isFailure } from 'effect/Exit';
import {
  type Effect,
  effectTry,
  exit,
  fail,
  failCause,
  flatMap,
  gen,
  succeed,
  tryPromise,
  uninterruptibleMask,
} from './release-effect';
import type { packReleaseArtifact } from './release-package';
import { readPackedArtifact } from './release-package-identity';
import { ReleaseReproductionError } from './release-reproduction-error';
import { nodeMkdir, nodeMkdtemp, nodeRm, spawnSync } from './release-runtime';
import { isReleaseSourceSha } from './release-source-sha';

const trailingSlash = /\/$/u;
const PACKAGE_PATH = 'packages/standards-cli';

const reproductionFailure = (operation: string, detail: string) =>
  new ReleaseReproductionError({
    message: `Authenticating published artifact failed while ${operation}: ${detail}`,
  });

const runGit = (
  repositoryPath: string,
  args: ReadonlyArray<string>,
  operation: string,
) =>
  effectTry({
    try: () =>
      spawnSync(
        [
          'git',
          '--no-replace-objects',
          '-c',
          'core.hooksPath=/dev/null',
          '-C',
          repositoryPath,
          ...args,
        ],
        { stderr: 'pipe', stdout: 'pipe' },
      ),
    catch: (cause) => reproductionFailure(operation, String(cause)),
  }).pipe(
    flatMap((result) =>
      result.exitCode === 0
        ? succeed(result.stdout.toString().trim())
        : fail(
            reproductionFailure(
              operation,
              result.stderr.toString().trim() || `exit ${result.exitCode}`,
            ),
          ),
    ),
  );

const verifyCandidate = (input: {
  readonly candidateSha: string;
  readonly currentSha: string;
  readonly repositoryPath: string;
}) =>
  gen(function* () {
    if (!isReleaseSourceSha(input.candidateSha)) {
      return yield* fail(
        reproductionFailure(
          'validating the candidate commit',
          `${input.candidateSha} is not a full lowercase commit SHA`,
        ),
      );
    }
    const objectType = yield* runGit(
      input.repositoryPath,
      ['cat-file', '-t', input.candidateSha],
      'resolving the candidate object',
    );
    if (objectType !== 'commit') {
      return yield* fail(
        reproductionFailure(
          'validating the candidate object',
          `${input.candidateSha} has type ${objectType}; expected commit`,
        ),
      );
    }
    yield* runGit(
      input.repositoryPath,
      ['merge-base', '--is-ancestor', input.candidateSha, input.currentSha],
      'verifying candidate ancestry',
    );
  });

const temporaryRoot = (temporaryDirectory: string) =>
  tryPromise({
    try: () =>
      nodeMkdtemp(
        `${temporaryDirectory.replace(trailingSlash, '')}/standards-release-reproduction-`,
      ),
    catch: (cause) =>
      reproductionFailure('creating the temporary workspace', String(cause)),
  });

const cleanup = (repositoryPath: string, root: string) =>
  tryPromise({
    try: () => nodeRm(root, { force: true, recursive: true }),
    catch: (cause) =>
      reproductionFailure('removing the temporary worktree', String(cause)),
  }).pipe(
    flatMap(() =>
      runGit(
        repositoryPath,
        ['worktree', 'prune'],
        'pruning the temporary worktree registration',
      ),
    ),
  );

const bracketTemporaryRoot = <A, E>(input: {
  readonly repositoryPath: string;
  readonly temporaryDirectory: string;
  readonly use: (root: string) => Effect<A, E>;
}) =>
  uninterruptibleMask((restore) =>
    gen(function* () {
      const root = yield* temporaryRoot(input.temporaryDirectory);
      const operationExit = yield* exit(restore(input.use(root)));
      const cleanupExit = yield* exit(cleanup(input.repositoryPath, root));
      if (isFailure(cleanupExit)) {
        return yield* failCause(cleanupExit.cause);
      }
      if (isFailure(operationExit)) {
        return yield* failCause(operationExit.cause);
      }
      return operationExit.value;
    }),
  );

export const reproduceCandidateArtifact = (input: {
  readonly candidateSha: string;
  readonly currentSha: string;
  readonly packArtifact: typeof packReleaseArtifact;
  readonly repositoryPath: string;
  readonly temporaryDirectory: string;
}) =>
  gen(function* () {
    yield* verifyCandidate(input);
    return yield* bracketTemporaryRoot({
      repositoryPath: input.repositoryPath,
      temporaryDirectory: input.temporaryDirectory,
      use: (root) =>
        gen(function* () {
          const worktree = `${root}/repository`;
          const destination = `${root}/artifact`;
          yield* runGit(
            input.repositoryPath,
            ['worktree', 'add', '--detach', worktree, input.candidateSha],
            'materializing the candidate repository',
          );
          yield* tryPromise({
            try: () => nodeMkdir(destination),
            catch: (cause) =>
              reproductionFailure(
                'creating the artifact directory',
                String(cause),
              ),
          });
          const artifact = yield* input.packArtifact({
            destination,
            expectedSha: input.candidateSha,
            packagePath: `${worktree}/${PACKAGE_PATH}`,
          });
          return yield* readPackedArtifact(artifact);
        }),
    });
  });
