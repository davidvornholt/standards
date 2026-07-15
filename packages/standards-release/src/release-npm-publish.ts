import { NpmRegistryError } from './npm-registry-error';
import { authorizeReleaseSha } from './release-authorization';
import {
  all,
  type Effect,
  effectTry,
  fail,
  gen,
  tryPromise,
} from './release-effect';
import type { GithubConnectionInput } from './release-github-client';
import { verifyPackedArtifact } from './release-package-identity';
import { env, spawn } from './release-runtime';

type Publisher = (artifact: string) => Effect<void, NpmRegistryError>;
type ArtifactVerifier = typeof verifyPackedArtifact;

const GITHUB_TOKEN_VARIABLES = new Set(['GH_TOKEN', 'GITHUB_TOKEN']);

export const npmPublishCommand = (artifact: string): ReadonlyArray<string> => [
  'npm',
  'publish',
  artifact,
  '--ignore-scripts',
  '--provenance',
  '--access',
  'public',
  '--tag',
  'latest',
  '--registry=https://registry.npmjs.org',
];

export const npmPublishEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !GITHUB_TOKEN_VARIABLES.has(entry[0]),
    ),
  );

const operationError = (operation: string, cause: unknown) =>
  new NpmRegistryError({
    message: `Publishing npm artifact failed while ${operation}: ${String(cause)}`,
  });

const publishWithNpm: Publisher = (artifact) =>
  gen(function* () {
    const subprocess = yield* effectTry({
      try: () =>
        spawn([...npmPublishCommand(artifact)], {
          env: npmPublishEnvironment(env),
          stderr: 'pipe',
          stdout: 'inherit',
        }),
      catch: (cause) => operationError('starting npm', cause),
    });
    const [exitCode, stderr] = yield* all(
      [
        tryPromise({
          try: () => subprocess.exited,
          catch: (cause) => operationError('waiting for npm', cause),
        }),
        tryPromise({
          try: () => new Response(subprocess.stderr).text(),
          catch: (cause) => operationError('reading npm stderr', cause),
        }),
      ] as const,
      { concurrency: 'unbounded' },
    );
    if (exitCode !== 0) {
      return yield* fail(
        new NpmRegistryError({
          message: `Publishing npm artifact failed: ${stderr.trim() || `exit ${exitCode}`}`,
        }),
      );
    }
  });

export const publishAuthorizedNpmArtifact = (
  input: GithubConnectionInput & {
    readonly artifact: string;
    readonly expectedIntegrity: string;
    readonly expectedSha: string;
  },
  publisher: Publisher = publishWithNpm,
  verifyArtifact: ArtifactVerifier = verifyPackedArtifact,
) =>
  gen(function* () {
    yield* authorizeReleaseSha(input);
    yield* verifyArtifact({
      artifact: input.artifact,
      expectedIntegrity: input.expectedIntegrity,
      expectedSha: input.expectedSha,
    });
    yield* publisher(input.artifact);
  });
