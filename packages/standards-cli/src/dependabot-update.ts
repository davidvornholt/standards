import { isNonEmptyString, isRecord } from './github-settings-parse';

export type UpdateBlock = Record<string, unknown>;

export type UpdateTarget = {
  readonly ecosystem: string;
  readonly targetBranch: string | null;
  readonly directories: ReadonlyArray<string>;
};

const listOfNonEmptyStrings = (
  value: unknown,
): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);

const inspectIgnoreEntry = (
  entry: unknown,
  label: string,
): ReadonlyArray<string> => {
  if (!isRecord(entry)) {
    return [`${label} must be a mapping`];
  }
  const problems: Array<string> = [];
  if (!isNonEmptyString(entry['dependency-name'])) {
    problems.push(`${label} must define a non-empty dependency-name`);
  }
  for (const key of ['versions', 'update-types'] as const) {
    const value = entry[key];
    if (value !== undefined && !listOfNonEmptyStrings(value)) {
      problems.push(`${label}.${key} must be a non-empty string list`);
    }
  }
  return problems;
};

export const inspectIgnore = (
  ignore: unknown,
  label: string,
): ReadonlyArray<string> => {
  if (ignore === undefined) {
    return [];
  }
  if (!Array.isArray(ignore)) {
    return [`${label}.ignore must be a list`];
  }
  const problems: Array<string> = [];
  for (const [index, entry] of ignore.entries()) {
    problems.push(...inspectIgnoreEntry(entry, `${label}.ignore[${index}]`));
  }
  return problems;
};

export const inspectRegistryReferences = (
  registries: unknown,
  label: string,
): ReadonlyArray<string> => {
  if (registries === undefined) {
    return [];
  }
  if (!listOfNonEmptyStrings(registries)) {
    return [`${label}.registries must be a non-empty string list`];
  }
  return new Set(registries).size === registries.length
    ? []
    : [`${label}.registries must not contain duplicates`];
};

export const updateTarget = (
  block: UpdateBlock,
  label: string,
  problems: Array<string>,
): UpdateTarget | null => {
  const ecosystem = block['package-ecosystem'];
  if (!isNonEmptyString(ecosystem)) {
    problems.push(`${label} must define package-ecosystem`);
  }
  const targetBranch = block['target-branch'];
  if (targetBranch !== undefined && !isNonEmptyString(targetBranch)) {
    problems.push(`${label}.target-branch must be a non-empty string`);
  }

  const { directory, directories } = block;
  const hasDirectory = Object.hasOwn(block, 'directory');
  const hasDirectories = Object.hasOwn(block, 'directories');
  if (hasDirectory === hasDirectories) {
    problems.push(
      `${label} must define exactly one of directory or directories`,
    );
    return null;
  }
  if (hasDirectory && !isNonEmptyString(directory)) {
    problems.push(`${label}.directory must be a non-empty string`);
    return null;
  }
  if (hasDirectories && !listOfNonEmptyStrings(directories)) {
    problems.push(`${label}.directories must be a non-empty string list`);
    return null;
  }
  const rawDirectories: ReadonlyArray<string> = hasDirectory
    ? [directory as string]
    : (directories as ReadonlyArray<string>);
  const normalized = [...new Set(rawDirectories)].sort();
  if (
    !hasDirectory &&
    Array.isArray(directories) &&
    normalized.length !== directories.length
  ) {
    problems.push(`${label}.directories must not contain duplicates`);
  }
  if (
    !isNonEmptyString(ecosystem) ||
    (targetBranch !== undefined && !isNonEmptyString(targetBranch))
  ) {
    return null;
  }
  return {
    ecosystem,
    targetBranch: targetBranch ?? null,
    directories: normalized,
  };
};

export const sameUpdateScope = (
  left: UpdateTarget,
  right: UpdateTarget,
): boolean =>
  left.ecosystem === right.ecosystem &&
  left.targetBranch === right.targetBranch;

export const sameUpdateTarget = (
  left: UpdateTarget,
  right: UpdateTarget,
): boolean =>
  sameUpdateScope(left, right) &&
  left.directories.length === right.directories.length &&
  left.directories.every(
    (directory, index) => directory === right.directories[index],
  );

export const overlapsUpdateTarget = (
  left: UpdateTarget,
  right: UpdateTarget,
): boolean =>
  sameUpdateScope(left, right) &&
  left.directories.some((directory) => right.directories.includes(directory));

export const updateTargetDescription = (target: UpdateTarget): string => {
  const branch =
    target.targetBranch === null
      ? 'the default target branch'
      : `target branch "${target.targetBranch}"`;
  return `"${target.ecosystem}" on ${branch} for ${target.directories.join(', ')}`;
};
