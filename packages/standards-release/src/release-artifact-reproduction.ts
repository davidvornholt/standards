import { ArtifactIdentityError } from './artifact-identity-error';
import { fail, gen } from './release-effect';
import { packReleaseArtifact } from './release-package';
import type { ReleasePackageError } from './release-package-error';
import { packedArtifactIntegrity } from './release-package-identity';
import type { ReleaseReproductionError } from './release-reproduction-error';
import { reproduceCandidateArtifact } from './release-reproduction-worktree';
import { nodeTimingSafeEqual } from './release-runtime';

export const authenticatePublishedArtifact = (input: {
  readonly candidateSha: string;
  readonly currentSha: string;
  readonly downloadedBytes: Uint8Array;
  readonly expectedIntegrity: string;
  readonly packArtifact?: typeof packReleaseArtifact;
  readonly repositoryPath: string;
  readonly temporaryDirectory: string;
}) =>
  gen(function* () {
    const reproducedBytes = yield* reproduceCandidateArtifact({
      ...input,
      packArtifact: input.packArtifact ?? packReleaseArtifact,
    });
    const reproducedIntegrity = packedArtifactIntegrity(reproducedBytes);
    if (reproducedIntegrity !== input.expectedIntegrity) {
      return yield* fail(
        new ArtifactIdentityError({
          message: `Reproduced package integrity ${reproducedIntegrity} does not match registry integrity ${input.expectedIntegrity}`,
        }),
      );
    }
    if (
      reproducedBytes.length !== input.downloadedBytes.length ||
      !nodeTimingSafeEqual(reproducedBytes, input.downloadedBytes)
    ) {
      return yield* fail(
        new ArtifactIdentityError({
          message:
            'Reproduced package bytes do not match the registry artifact',
        }),
      );
    }
    return input.candidateSha;
  });

export type ArtifactAuthenticationError =
  | ArtifactIdentityError
  | ReleasePackageError
  | ReleaseReproductionError;
