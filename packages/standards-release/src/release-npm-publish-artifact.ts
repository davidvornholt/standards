import { isFailure } from 'effect/Exit';
import {
  type Effect,
  exit,
  failCause,
  gen,
  tryPromise,
} from './release-effect';
import { bracketEffect } from './release-effect-resource';
import { stagedArtifactFailure } from './release-npm-publish-error';
import { readStagedArtifact } from './release-npm-publish-read';
import {
  readPackedArtifact,
  verifyPackedArtifactBytes,
} from './release-package-identity';
import {
  nodeChmod,
  nodeMkdtemp,
  nodeOpen,
  nodeRm,
  nodeSymlink,
  nodeTmpdir,
  nodeUnlink,
  type RuntimeFileHandle,
} from './release-runtime';

export type StagedNpmArtifact = {
  readonly adapterPath: string;
  readonly descriptor: number;
};

export type ArtifactReader = typeof readPackedArtifact;
export type ArtifactVerifier = typeof verifyPackedArtifactBytes;

const NPM_ARTIFACT_DESCRIPTOR = 3;
const PRIVATE_DIRECTORY_MODE = 0o500;
const READ_ONLY_ARTIFACT_MODE = 0o400;
const WRITABLE_ARTIFACT_MODE = 0o600;
const WRITABLE_DIRECTORY_MODE = 0o700;
const trailingSlash = /\/$/u;

const temporaryRoot = () =>
  tryPromise({
    try: () =>
      nodeMkdtemp(
        `${nodeTmpdir().replace(trailingSlash, '')}/standards-release-npm-`,
      ),
    catch: (cause) =>
      stagedArtifactFailure('creating a private directory', cause),
  });

const cleanupRoot = (root: string) =>
  gen(function* () {
    const unlockExit = yield* exit(
      tryPromise({
        try: () => nodeChmod(root, WRITABLE_DIRECTORY_MODE),
        catch: (cause) =>
          stagedArtifactFailure(
            'unlocking the private directory for cleanup',
            cause,
          ),
      }),
    );
    const removalExit = yield* exit(
      tryPromise({
        try: () => nodeRm(root, { force: true, recursive: true }),
        catch: (cause) =>
          stagedArtifactFailure('removing the private directory', cause),
      }),
    );
    if (isFailure(unlockExit)) {
      return yield* failCause(unlockExit.cause);
    }
    if (isFailure(removalExit)) {
      return yield* failCause(removalExit.cause);
    }
  });

const closeArtifact = (handle: RuntimeFileHandle) =>
  tryPromise({
    try: () => handle.close(),
    catch: (cause) =>
      stagedArtifactFailure('closing the staged artifact', cause),
  });

const openArtifact = (path: string, flags: 'r' | 'wx') =>
  tryPromise({
    try: () => nodeOpen(path, flags, WRITABLE_ARTIFACT_MODE),
    catch: (cause) =>
      stagedArtifactFailure('opening the staged artifact', cause),
  });

const writeArtifact = (handle: RuntimeFileHandle, bytes: Uint8Array) =>
  gen(function* () {
    yield* tryPromise({
      try: () => handle.writeFile(bytes),
      catch: (cause) =>
        stagedArtifactFailure('writing the staged artifact', cause),
    });
    yield* tryPromise({
      try: () => handle.sync(),
      catch: (cause) =>
        stagedArtifactFailure('syncing the staged artifact', cause),
    });
  });

const prepareAdapter = (root: string, adapterPath: string) =>
  gen(function* () {
    yield* tryPromise({
      try: () =>
        nodeSymlink(`/proc/self/fd/${NPM_ARTIFACT_DESCRIPTOR}`, adapterPath),
      catch: (cause) =>
        stagedArtifactFailure('creating the npm adapter', cause),
    });
    yield* tryPromise({
      try: () => nodeChmod(root, PRIVATE_DIRECTORY_MODE),
      catch: (cause) =>
        stagedArtifactFailure('locking the private directory', cause),
    });
  });

export const withVerifiedNpmArtifact = <A, E>(
  input: {
    readonly artifact: string;
    readonly expectedIntegrity: string;
    readonly expectedSha: string;
  },
  use: (artifact: StagedNpmArtifact) => Effect<A, E>,
  verifyArtifact: ArtifactVerifier = verifyPackedArtifactBytes,
  sourceReader: ArtifactReader = readPackedArtifact,
) =>
  bracketEffect({
    acquire: temporaryRoot(),
    release: cleanupRoot,
    use: (root) =>
      gen(function* () {
        const bytes = yield* sourceReader(input.artifact);
        const stagedPath = `${root}/artifact`;
        yield* bracketEffect({
          acquire: openArtifact(stagedPath, 'wx'),
          release: closeArtifact,
          use: (writer) => writeArtifact(writer, bytes),
        });
        yield* tryPromise({
          try: () => nodeChmod(stagedPath, READ_ONLY_ARTIFACT_MODE),
          catch: (cause) =>
            stagedArtifactFailure('locking the staged artifact', cause),
        });
        const adapterPath = `${root}/verified-package.tgz`;
        return yield* bracketEffect({
          acquire: openArtifact(stagedPath, 'r'),
          release: closeArtifact,
          use: (handle) =>
            gen(function* () {
              yield* tryPromise({
                try: () => nodeUnlink(stagedPath),
                catch: (cause) =>
                  stagedArtifactFailure('unlinking the staged artifact', cause),
              });
              const stagedBytes = yield* readStagedArtifact(handle);
              yield* verifyArtifact({
                bytes: stagedBytes,
                expectedIntegrity: input.expectedIntegrity,
                expectedSha: input.expectedSha,
              });
              yield* prepareAdapter(root, adapterPath);
              return yield* use({
                adapterPath,
                descriptor: handle.fd,
              });
            }),
        });
      }),
  });
