export type StableVersion = readonly [bigint, bigint, bigint];

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
