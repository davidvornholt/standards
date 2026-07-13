export type ReleasePlan = {
  readonly publish: boolean;
  readonly reconcile: boolean;
};

export type ReconciliationAction = 'create' | 'exists';

export type Decision<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly error: string; readonly ok: false };

const stableSemver =
  /^(?<major>0|[1-9][0-9]*)\.(?<minor>0|[1-9][0-9]*)\.(?<patch>0|[1-9][0-9]*)$/u;

const parseVersion = (
  version: string,
): Decision<readonly [number, number, number]> => {
  const match = stableSemver.exec(version);
  const { major, minor, patch } = match?.groups ?? {};
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

export const classifyReleaseDeclaration = (input: {
  readonly parentVersion: string | null;
  readonly version: string;
}): Decision<boolean> => {
  const version = parseVersion(input.version);
  if (!version.ok) {
    return version;
  }
  if (input.parentVersion === null) {
    return { ok: true, value: true };
  }

  const parentVersion = parseVersion(input.parentVersion);
  if (!parentVersion.ok) {
    return { ok: true, value: true };
  }
  const comparison = compareVersions(version.value, parentVersion.value);
  if (comparison < 0) {
    return {
      error: `Declared version ${input.version} must not be older than first-parent version ${input.parentVersion}`,
      ok: false,
    };
  }
  return { ok: true, value: comparison > 0 };
};

export const decideRelease = (input: {
  readonly npmLatest: string | null;
  readonly npmVersionExists: boolean;
  readonly parentVersion: string | null;
  readonly version: string;
}): Decision<ReleasePlan> => {
  const declaration = classifyReleaseDeclaration(input);
  if (!declaration.ok) {
    return declaration;
  }
  if (!declaration.value) {
    return { ok: true, value: { publish: false, reconcile: false } };
  }

  const version = parseVersion(input.version);
  if (!version.ok) {
    return version;
  }
  if (input.npmLatest !== null) {
    const npmLatest = parseVersion(input.npmLatest);
    if (!npmLatest.ok) {
      return {
        error: `npm latest ${input.npmLatest} must be a stable SemVer`,
        ok: false,
      };
    }
    if (compareVersions(version.value, npmLatest.value) < 0) {
      return {
        error: `Manifest version ${input.version} is behind npm latest ${input.npmLatest}`,
        ok: false,
      };
    }
  } else if (input.npmVersionExists) {
    return {
      error:
        'npm reports the declared version without an authoritative latest version',
      ok: false,
    };
  }

  return {
    ok: true,
    value: { publish: !input.npmVersionExists, reconcile: true },
  };
};

export const decideArtifactIdentity = (input: {
  readonly expectedIntegrity: string;
  readonly expectedSha: string;
  readonly npmGitHead: string | null;
  readonly npmIntegrity: string | null;
  readonly npmVersionExists: boolean;
}): Decision<true> => {
  if (!input.npmVersionExists) {
    return { ok: true, value: true };
  }
  if (input.npmIntegrity === null) {
    return { error: 'Existing npm version has no dist.integrity', ok: false };
  }
  if (input.npmIntegrity !== input.expectedIntegrity) {
    return {
      error: `Existing npm artifact integrity ${input.npmIntegrity} does not match expected ${input.expectedIntegrity}`,
      ok: false,
    };
  }
  if (input.npmGitHead !== null && input.npmGitHead !== input.expectedSha) {
    return {
      error: `Existing npm artifact gitHead ${input.npmGitHead} does not match expected ${input.expectedSha}`,
      ok: false,
    };
  }
  return { ok: true, value: true };
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
