export const invalidRepositoryValues = [
  ['allow_auto_merge', 'true'],
  ['allow_merge_commit', 1],
  ['allow_rebase_merge', null],
  ['allow_squash_merge', []],
  ['delete_branch_on_merge', {}],
  ['squash_merge_commit_message', 'PULL_REQUEST_BODY'],
  ['squash_merge_commit_title', 'SQUASH_TITLE'],
] as const;
