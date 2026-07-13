export type ReleasePlan = {
  readonly publish: boolean;
  readonly reconcile: boolean;
};

export type ReconciliationAction = 'create' | 'exists';

type Decision<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly error: string; readonly ok: false };

const stableSemver =
  /^(?<major>0|[1-9][0-9]*)\.(?<minor>0|[1-9][0-9]*)\.(?<patch>0|[1-9][0-9]*)$/u;

const parseVersion = (
  version: string,
): Decision<readonly [number, number, number]> => {
  const match = stableSemver.exec(version);
  if (match === null) {
    return { error: `Version ${version} must be a stable SemVer`, ok: false };
  }
  const { major, minor, patch } = match.groups ?? {};
  if (major === undefined || minor === undefined || patch === undefined) {
    return { error: `Version ${version} must be a stable SemVer`, ok: false };
  }

  return {
    ok: true,
    value: [Number(major), Number(minor), Number(patch)],
  };
};

const compareVersions = (
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number => {
  for (const index of [0, 1, 2] as const) {
    const difference = left[index] - right[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

export const decideRelease = (input: {
  readonly npmLatest: string | null;
  readonly npmVersionExists: boolean;
  readonly parentVersion: string;
  readonly version: string;
}): Decision<ReleasePlan> => {
  if (input.version === input.parentVersion) {
    return { ok: true, value: { publish: false, reconcile: false } };
  }

  const version = parseVersion(input.version);
  if (!version.ok) {
    return version;
  }
  const parentVersion = parseVersion(input.parentVersion);
  if (!parentVersion.ok) {
    return parentVersion;
  }
  if (compareVersions(version.value, parentVersion.value) <= 0) {
    return {
      error: `Declared version ${input.version} must be newer than first-parent version ${input.parentVersion}`,
      ok: false,
    };
  }
  if (input.npmLatest === null) {
    return {
      error: 'npm latest is required for a release declaration',
      ok: false,
    };
  }

  const npmLatest = parseVersion(input.npmLatest);
  if (!npmLatest.ok) {
    return npmLatest;
  }
  if (compareVersions(version.value, npmLatest.value) < 0) {
    return {
      error: `Manifest version ${input.version} is behind npm latest ${input.npmLatest}`,
      ok: false,
    };
  }

  return {
    ok: true,
    value: { publish: !input.npmVersionExists, reconcile: true },
  };
};

export const decideReconciliation = (input: {
  readonly expectedSha: string;
  readonly releaseStatus: 'absent' | 'draft' | 'published';
  readonly tagSha: string | null;
}): Decision<ReconciliationAction> => {
  if (input.releaseStatus === 'draft') {
    return { error: 'Release already exists as a draft', ok: false };
  }
  if (input.tagSha !== null && input.tagSha !== input.expectedSha) {
    return {
      error: `Release tag points to ${input.tagSha}, expected ${input.expectedSha}`,
      ok: false,
    };
  }
  if (input.releaseStatus === 'published') {
    if (input.tagSha === null) {
      return {
        error: 'Published release has no matching remote tag',
        ok: false,
      };
    }
    return { ok: true, value: 'exists' };
  }

  return { ok: true, value: 'create' };
};
