import { isFailure } from 'effect/Exit';
import type { ArtifactIdentityError } from '../src/artifact-identity-error';
import type { GithubApiError } from '../src/github-api-error';
import { appendGithubOutput } from '../src/github-output';
import type { GithubStateError } from '../src/github-state-error';
import type { NpmRegistryError } from '../src/npm-registry-error';
import { renderReleaseCause } from '../src/release-cause-output';
import {
  type Effect,
  fail,
  gen,
  runPromiseExit,
  succeed,
} from '../src/release-effect';
import {
  inspectGithubRelease,
  reconcileGithubRelease,
} from '../src/release-github';
import { ReleaseInputError } from '../src/release-input-error';
import { inspectNpmRelease } from '../src/release-npm';
import { publishAuthorizedNpmArtifact } from '../src/release-npm-publish';
import type { ReleaseOutputError } from '../src/release-output-error';
import { packReleaseArtifact } from '../src/release-package';
import type { ReleasePackageError } from '../src/release-package-error';
import { verifyPackedArtifact } from '../src/release-package-identity';
import type { ReleaseReproductionError } from '../src/release-reproduction-error';
import {
  argv,
  env,
  runtimeProcess,
  stderr,
  write,
} from '../src/release-runtime';
import type { ReleaseValidationError } from '../src/release-validation-error';

const environment = env;
const RELEASE_SHA_OUTPUT = 'release_sha';

type ReleaseError =
  | ArtifactIdentityError
  | GithubApiError
  | GithubStateError
  | NpmRegistryError
  | ReleaseInputError
  | ReleaseOutputError
  | ReleasePackageError
  | ReleaseReproductionError
  | ReleaseValidationError;

const requireValue = (value: string | undefined, name: string) =>
  value === undefined || value === ''
    ? fail(new ReleaseInputError({ message: `${name} is required` }))
    : succeed(value);

const firstNonEmpty = (
  values: ReadonlyArray<string | undefined>,
): string | undefined =>
  values.find((value) => value !== undefined && value !== '');

const writeOutput = (
  output: string,
  values: Readonly<Record<string, string | boolean>>,
) => appendGithubOutput(output, values);

const inspectNpm = (args: ReadonlyArray<string>) =>
  gen(function* () {
    const [
      output,
      name,
      version,
      currentSha,
      repositoryPath,
      temporaryDirectory,
    ] = args;
    const outputPath = yield* requireValue(output, 'GitHub output path');
    const inspection = yield* inspectNpmRelease({
      currentSha: yield* requireValue(currentSha, 'current tested sha'),
      name: yield* requireValue(name, 'package name'),
      repositoryPath: yield* requireValue(repositoryPath, 'repository path'),
      temporaryDirectory: yield* requireValue(
        temporaryDirectory,
        'temporary directory',
      ),
      version: yield* requireValue(version, 'release version'),
    });
    yield* writeOutput(outputPath, {
      publish: inspection.publish,
      reconcile: inspection.reconcile,
      [RELEASE_SHA_OUTPUT]: inspection.releaseSha,
    });
  });

const pack = (args: ReadonlyArray<string>) =>
  gen(function* () {
    const [output, packagePath, destination, expectedSha] = args;
    const outputPath = yield* requireValue(output, 'GitHub output path');
    const releaseSha = yield* requireValue(expectedSha, 'release sha');
    const artifact = yield* packReleaseArtifact({
      destination: yield* requireValue(destination, 'artifact destination'),
      expectedSha: releaseSha,
      packagePath: yield* requireValue(packagePath, 'package path'),
    });
    const integrity = yield* verifyPackedArtifact({
      artifact,
      expectedSha: releaseSha,
    });
    yield* writeOutput(outputPath, { artifact, integrity });
  });

const github = (mode: 'inspect' | 'reconcile', args: ReadonlyArray<string>) =>
  gen(function* () {
    const [output, expectedSha, tag] = args;
    const outputPath = yield* requireValue(output, 'GitHub output path');
    const input = {
      expectedSha: yield* requireValue(expectedSha, 'release sha'),
      token: yield* requireValue(
        firstNonEmpty([environment.GH_TOKEN, environment.GITHUB_TOKEN]),
        'GitHub token',
      ),
      repo: yield* requireValue(
        environment.GITHUB_REPOSITORY,
        'GitHub repository',
      ),
      tag: yield* requireValue(tag, 'release tag'),
    };
    const action = yield* mode === 'inspect'
      ? inspectGithubRelease(input)
      : reconcileGithubRelease(input);
    yield* writeOutput(outputPath, { action });
  });

const publishNpm = (args: ReadonlyArray<string>) =>
  gen(function* () {
    const [expectedSha, expectedIntegrity, artifact] = args;
    yield* publishAuthorizedNpmArtifact({
      artifact: yield* requireValue(artifact, 'package tarball'),
      expectedIntegrity: yield* requireValue(
        expectedIntegrity,
        'package integrity',
      ),
      expectedSha: yield* requireValue(expectedSha, 'release sha'),
      token: yield* requireValue(
        firstNonEmpty([environment.GH_TOKEN, environment.GITHUB_TOKEN]),
        'GitHub token',
      ),
      repo: yield* requireValue(
        environment.GITHUB_REPOSITORY,
        'GitHub repository',
      ),
    });
  });

const main = (): Effect<void, ReleaseError> => {
  const [command, ...args] = argv.slice(2);
  if (command === 'pack') {
    return pack(args);
  }
  if (command === 'npm') {
    return inspectNpm(args);
  }
  if (command === 'npm-publish') {
    return publishNpm(args);
  }
  if (command === 'github-inspect') {
    return github('inspect', args);
  }
  if (command === 'github-reconcile') {
    return github('reconcile', args);
  }
  return fail(
    new ReleaseInputError({
      message:
        'Expected release-state command pack, npm, npm-publish, github-inspect, or github-reconcile',
    }),
  );
};

const exit = await runPromiseExit(main());
if (isFailure(exit)) {
  await write(stderr, renderReleaseCause(exit.cause));
  runtimeProcess.exitCode = 1;
}
