import { GithubStateError } from './github-state-error';
import {
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

export const decideRelease = (input: {
  readonly npmLatest: string | null;
  readonly npmVersionExists: boolean;
  readonly version: string;
}) =>
  gen(function* () {
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
