export const SUPPORTED_REPOSITORY_SETTING_KEYS = [
  'allow_auto_merge',
  'allow_merge_commit',
  'allow_rebase_merge',
  'allow_squash_merge',
  'delete_branch_on_merge',
  'squash_merge_commit_message',
  'squash_merge_commit_title',
] as const;

const BOOLEAN_REPOSITORY_SETTINGS = new Set([
  'allow_auto_merge',
  'allow_merge_commit',
  'allow_rebase_merge',
  'allow_squash_merge',
  'delete_branch_on_merge',
]);
const SQUASH_COMMIT_MESSAGES = new Set(['BLANK', 'COMMIT_MESSAGES', 'PR_BODY']);
const SQUASH_COMMIT_TITLES = new Set(['COMMIT_OR_PR_TITLE', 'PR_TITLE']);

export const repositorySettingValueProblem = (
  key: string,
  value: unknown,
  label: string,
): string | null => {
  if (BOOLEAN_REPOSITORY_SETTINGS.has(key) && typeof value !== 'boolean') {
    return `${label}."${key}" must be a boolean`;
  }
  if (
    key === 'squash_merge_commit_message' &&
    !(typeof value === 'string' && SQUASH_COMMIT_MESSAGES.has(value))
  ) {
    return `${label}."${key}" must be BLANK, COMMIT_MESSAGES, or PR_BODY`;
  }
  if (
    key === 'squash_merge_commit_title' &&
    !(typeof value === 'string' && SQUASH_COMMIT_TITLES.has(value))
  ) {
    return `${label}."${key}" must be COMMIT_OR_PR_TITLE or PR_TITLE`;
  }
  return null;
};

export type DecodedLiveRepositorySettings = {
  readonly invalidKeys: ReadonlySet<string>;
  readonly problems: ReadonlyArray<string>;
  readonly settings: Readonly<Record<string, unknown>>;
};

export const decodeLiveRepositorySettings = (
  response: Readonly<Record<string, unknown>>,
  declared: Readonly<Record<string, unknown>>,
  detailRequired: boolean,
): DecodedLiveRepositorySettings => {
  const invalidKeys = new Set<string>();
  const problems: Array<string> = [];
  const settings: Record<string, unknown> = {};
  for (const key of SUPPORTED_REPOSITORY_SETTING_KEYS) {
    const value = response[key];
    if (value === undefined) {
      if (detailRequired && declared[key] !== undefined) {
        problems.push(
          `GitHub repository response omitted managed setting "${key}"; apply requires an admin-visible value`,
        );
      }
    } else {
      const problem = repositorySettingValueProblem(
        key,
        value,
        'GitHub repository response',
      );
      if (problem === null) {
        settings[key] = value;
      } else {
        invalidKeys.add(key);
        problems.push(problem);
      }
    }
  }
  return { invalidKeys, problems, settings };
};
