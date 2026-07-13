import { ArtifactIdentityError } from './artifact-identity-error';
import { GithubStateError } from './github-state-error';
import {
  classifyReleaseDeclaration as classifyDeclaration,
  compareStableVersions,
  parseStableVersion,
} from './release-declaration';
import { fail, gen, succeed } from './release-effect';
import { ReleaseValidationError } from './release-validation-error';

export type ReleasePlan = {
  readonly publish: boolean;
  readonly reconcile: boolean;
};

export type ReconciliationAction = 'create' | 'exists';

const parseVersion = (version: string, label = 'Version') => {
  const parsed = parseStableVersion(version);
  if (parsed === null) {
    return fail(
      new ReleaseValidationError({
        message: `${label} ${version} must be a stable SemVer`,
      }),
    );
  }
  return succeed(parsed);
};

export const classifyReleaseDeclaration = (input: {
  readonly parentVersion: string | null;
  readonly version: string;
}) => {
  const result = classifyDeclaration(input);
  return result.ok
    ? succeed(result.declared)
    : fail(new ReleaseValidationError({ message: result.message }));
};

export const decideRelease = (input: {
  readonly npmLatest: string | null;
  readonly npmVersionExists: boolean;
  readonly parentVersion: string | null;
  readonly version: string;
}) =>
  gen(function* () {
    const declaration = yield* classifyReleaseDeclaration(input);
    if (!declaration) {
      return { publish: false, reconcile: false } satisfies ReleasePlan;
    }
    const version = yield* parseVersion(input.version);
    if (input.npmLatest !== null) {
      const npmLatest = yield* parseVersion(input.npmLatest, 'npm latest');
      if (
        compareStableVersions(version, npmLatest) < 0 &&
        !input.npmVersionExists
      ) {
        return yield* fail(
          new ReleaseValidationError({
            message: `Manifest version ${input.version} is behind npm latest ${input.npmLatest}`,
          }),
        );
      }
    } else if (input.npmVersionExists) {
      return yield* fail(
        new ReleaseValidationError({
          message:
            'npm reports the declared version without an authoritative latest version',
        }),
      );
    }
    return {
      publish: !input.npmVersionExists,
      reconcile: true,
    } satisfies ReleasePlan;
  });

export const verifyArtifactIdentity = (input: {
  readonly expectedIntegrity: string;
  readonly expectedSha: string;
  readonly npmGitHead: string | null;
  readonly npmIntegrity: string | null;
  readonly npmVersionExists: boolean;
}) => {
  if (!input.npmVersionExists) {
    return succeed(undefined);
  }
  if (input.npmIntegrity === null) {
    return fail(
      new ArtifactIdentityError({
        message: 'Existing npm version has no dist.integrity',
      }),
    );
  }
  if (input.npmIntegrity !== input.expectedIntegrity) {
    return fail(
      new ArtifactIdentityError({
        message: `Existing npm artifact integrity ${input.npmIntegrity} does not match expected ${input.expectedIntegrity}`,
      }),
    );
  }
  if (input.npmGitHead !== null && input.npmGitHead !== input.expectedSha) {
    return fail(
      new ArtifactIdentityError({
        message: `Existing npm artifact gitHead ${input.npmGitHead} does not match expected ${input.expectedSha}`,
      }),
    );
  }
  return succeed(undefined);
};

export const decideReconciliation = (input: {
  readonly expectedSha: string;
  readonly releaseStatus: 'absent' | 'draft' | 'prerelease' | 'published';
  readonly tagSha: string | null;
}) => {
  if (input.releaseStatus === 'draft') {
    return fail(
      new GithubStateError({ message: 'Release already exists as a draft' }),
    );
  }
  if (input.releaseStatus === 'prerelease') {
    return fail(
      new GithubStateError({
        message: 'Release already exists as a prerelease',
      }),
    );
  }
  if (input.tagSha !== null && input.tagSha !== input.expectedSha) {
    return fail(
      new GithubStateError({
        message: `Release tag points to ${input.tagSha}, expected ${input.expectedSha}`,
      }),
    );
  }
  if (input.releaseStatus === 'published') {
    return input.tagSha === null
      ? fail(
          new GithubStateError({
            message: 'Published release has no matching remote tag',
          }),
        )
      : succeed('exists' as const);
  }
  return succeed('create' as const);
};
