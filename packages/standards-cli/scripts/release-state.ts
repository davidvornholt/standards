import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { failureOption, pretty } from 'effect/Cause';
import { isFailure } from 'effect/Exit';
import { isSome } from 'effect/Option';
import type { ArtifactIdentityError } from '../src/artifact-identity-error';
import type { GithubApiError } from '../src/github-api-error';
import type { GithubStateError } from '../src/github-state-error';
import type { NpmRegistryError } from '../src/npm-registry-error';
import {
  type Effect,
  effectTry,
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
import { ReleaseOutputError } from '../src/release-output-error';
import { classifyReleaseDeclaration } from '../src/release-state';
import type { ReleaseValidationError } from '../src/release-validation-error';

// biome-ignore lint/style/noProcessEnv: This workflow entrypoint receives its deployment configuration from GitHub Actions.
const environment = process.env;

type ReleaseError =
  | ArtifactIdentityError
  | GithubApiError
  | GithubStateError
  | NpmRegistryError
  | ReleaseInputError
  | ReleaseOutputError
  | ReleaseValidationError;

const requireValue = (value: string | undefined, name: string) =>
  value === undefined || value === ''
    ? fail(new ReleaseInputError({ message: `${name} is required` }))
    : succeed(value);

const nullableArg = (value: string | undefined): string | null => {
  const present = value ?? '';
  return present === '' ? null : present;
};

const writeOutput = (
  output: string,
  values: Readonly<Record<string, string | boolean>>,
) =>
  effectTry({
    try: () => {
      const lines = Object.entries(values).map(
        ([key, value]) => `${key}=${value}\n`,
      );
      appendFileSync(output, lines.join(''));
    },
    catch: (cause) =>
      new ReleaseOutputError({
        message: `Writing GitHub outputs failed: ${String(cause)}`,
      }),
  });

const classify = (args: ReadonlyArray<string>) =>
  gen(function* () {
    const [output, version, parentVersion] = args;
    const outputPath = yield* requireValue(output, 'GitHub output path');
    const requiredVersion = yield* requireValue(version, 'release version');
    const declared = yield* classifyReleaseDeclaration({
      parentVersion: nullableArg(parentVersion),
      version: requiredVersion,
    });
    yield* writeOutput(outputPath, {
      declared,
      tag: `v${requiredVersion}`,
      version: requiredVersion,
    });
  });

const inspectNpm = (args: ReadonlyArray<string>) =>
  gen(function* () {
    const [output, name, version, parentVersion, artifact, expectedSha] = args;
    const outputPath = yield* requireValue(output, 'GitHub output path');
    const inspection = yield* inspectNpmRelease({
      artifact: yield* requireValue(artifact, 'package artifact'),
      expectedSha: yield* requireValue(expectedSha, 'release sha'),
      name: yield* requireValue(name, 'package name'),
      parentVersion: nullableArg(parentVersion),
      version: yield* requireValue(version, 'release version'),
    });
    yield* writeOutput(outputPath, inspection);
  });

const github = (mode: 'inspect' | 'reconcile', args: ReadonlyArray<string>) =>
  gen(function* () {
    const [output, expectedSha, tag] = args;
    const outputPath = yield* requireValue(output, 'GitHub output path');
    const input = {
      expectedSha: yield* requireValue(expectedSha, 'release sha'),
      repo: yield* requireValue(
        environment.GITHUB_REPOSITORY,
        'GitHub repository',
      ),
      tag: yield* requireValue(tag, 'release tag'),
      token: yield* requireValue(
        environment.GH_TOKEN ?? environment.GITHUB_TOKEN,
        'GitHub token',
      ),
    };
    const action = yield* mode === 'inspect'
      ? inspectGithubRelease(input)
      : reconcileGithubRelease(input);
    yield* writeOutput(outputPath, { action });
  });

const main = (): Effect<void, ReleaseError> => {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'classify') {
    return classify(args);
  }
  if (command === 'npm') {
    return inspectNpm(args);
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
        'Expected release-state command classify, npm, github-inspect, or github-reconcile',
    }),
  );
};

const exit = await runPromiseExit(main());
if (isFailure(exit)) {
  const failure = failureOption(exit.cause);
  const message = isSome(failure) ? failure.value.message : pretty(exit.cause);
  process.stderr.write(`::error::${message}\n`);
  process.exit(1);
}
