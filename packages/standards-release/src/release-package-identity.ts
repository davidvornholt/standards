import { ArtifactIdentityError } from './artifact-identity-error';
import {
  effectTry,
  fail,
  flatMap,
  map,
  mapError,
  succeed,
  tryPromise,
} from './release-effect';
import { readReleaseTarIdentity } from './release-package-tar';
import { BunCryptoHasher, file, nodeGunzipSync } from './release-runtime';

export const packedArtifactIntegrity = (bytes: Uint8Array): string => {
  const digest = new BunCryptoHasher('sha512').update(bytes).digest('base64');
  return `sha512-${digest}`;
};

export const readPackedArtifact = (artifact: string) =>
  tryPromise({
    try: () => file(artifact).arrayBuffer(),
    catch: (cause) =>
      new ArtifactIdentityError({
        message: `Reading package artifact failed: ${String(cause)}`,
      }),
  }).pipe(map((bytes) => new Uint8Array(bytes)));

export const inspectPackedArtifactBytes = (input: {
  readonly bytes: Uint8Array;
  readonly expectedIntegrity?: string;
}) => {
  const actualIntegrity = packedArtifactIntegrity(input.bytes);
  if (
    input.expectedIntegrity !== undefined &&
    actualIntegrity !== input.expectedIntegrity
  ) {
    return fail(
      new ArtifactIdentityError({
        message: `Package artifact integrity ${actualIntegrity} does not match expected ${input.expectedIntegrity}`,
      }),
    );
  }
  return effectTry({
    try: () => nodeGunzipSync(input.bytes),
    catch: (cause) =>
      new ArtifactIdentityError({
        message: `Decompressing package artifact failed: ${String(cause)}`,
      }),
  }).pipe(
    flatMap((archive) =>
      readReleaseTarIdentity(archive).pipe(
        mapError(
          (error) => new ArtifactIdentityError({ message: error.message }),
        ),
      ),
    ),
    map((identity) => ({ ...identity, integrity: actualIntegrity })),
  );
};

export const verifyPackedArtifactBytes = (input: {
  readonly bytes: Uint8Array;
  readonly expectedIntegrity?: string;
  readonly expectedSha: string;
}) =>
  inspectPackedArtifactBytes(input).pipe(
    flatMap((identity) =>
      identity.sha === input.expectedSha
        ? succeed(identity.integrity)
        : fail(
            new ArtifactIdentityError({
              message: `Package artifact source commit ${identity.sha} does not match expected ${input.expectedSha}`,
            }),
          ),
    ),
  );

export const verifyPackedArtifact = (input: {
  readonly artifact: string;
  readonly expectedIntegrity?: string;
  readonly expectedSha: string;
}) =>
  readPackedArtifact(input.artifact).pipe(
    flatMap((bytes) => verifyPackedArtifactBytes({ ...input, bytes })),
  );
