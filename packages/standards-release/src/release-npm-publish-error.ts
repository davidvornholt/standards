import { ArtifactIdentityError } from './artifact-identity-error';

export const stagedArtifactFailure = (operation: string, cause: unknown) =>
  new ArtifactIdentityError({
    message: `Preparing package artifact failed while ${operation}: ${String(cause)}`,
  });
