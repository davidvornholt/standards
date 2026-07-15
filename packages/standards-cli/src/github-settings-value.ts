export type GithubSettings = {
  readonly defaultBranchProtection: Readonly<Record<string, unknown>> | null;
  readonly environments: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly repository: Readonly<Record<string, unknown>>;
  readonly rulesets: ReadonlyArray<Readonly<Record<string, unknown>>>;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isPositiveSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

export const unknownKeyProblems = (
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  prefix: string,
): ReadonlyArray<string> =>
  Object.keys(value).flatMap((key) =>
    allowed.has(key) ? [] : [`${prefix} has unknown key "${key}"`],
  );
