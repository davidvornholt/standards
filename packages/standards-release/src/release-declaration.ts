export type StableVersion = readonly [bigint, bigint, bigint];

export type ReleaseDeclarationResult =
  | { readonly declared: boolean; readonly ok: true }
  | { readonly message: string; readonly ok: false };

const stableSemver =
  /^(?<major>0|[1-9][0-9]*)\.(?<minor>0|[1-9][0-9]*)\.(?<patch>0|[1-9][0-9]*)$/u;

export const parseStableVersion = (version: string): StableVersion | null => {
  const match = stableSemver.exec(version);
  const { major, minor, patch } = match?.groups ?? {};
  return major === undefined || minor === undefined || patch === undefined
    ? null
    : [BigInt(major), BigInt(minor), BigInt(patch)];
};

export const compareStableVersions = (
  left: StableVersion,
  right: StableVersion,
): number => {
  for (const index of [0, 1, 2] as const) {
    if (left[index] > right[index]) {
      return 1;
    }
    if (left[index] < right[index]) {
      return -1;
    }
  }
  return 0;
};

export const classifyReleaseDeclaration = (input: {
  readonly parentVersion: string | null;
  readonly version: string;
}): ReleaseDeclarationResult => {
  const version = parseStableVersion(input.version);
  if (version === null) {
    return {
      message: `Version ${input.version} must be a stable SemVer`,
      ok: false,
    };
  }
  if (input.parentVersion === null) {
    return { declared: true, ok: true };
  }
  const parent = parseStableVersion(input.parentVersion);
  if (parent === null) {
    return { declared: true, ok: true };
  }
  const comparison = compareStableVersions(version, parent);
  return comparison < 0
    ? {
        message: `Declared version ${input.version} must not be older than first-parent version ${input.parentVersion}`,
        ok: false,
      }
    : { declared: comparison > 0, ok: true };
};
