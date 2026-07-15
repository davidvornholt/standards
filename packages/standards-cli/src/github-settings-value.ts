export type GithubSettings = {
  readonly defaultBranchProtection: Readonly<Record<string, unknown>> | null;
  readonly environments: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly repository: Readonly<Record<string, unknown>>;
  readonly rulesets: ReadonlyArray<Readonly<Record<string, unknown>>>;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
