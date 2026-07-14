import { readFile } from 'node:fs/promises';

export const declaredDefaultBranchProtection = JSON.parse(
  await readFile(
    new URL('../../../.github/settings.json', import.meta.url),
    'utf8',
  ),
).default_branch_protection as Readonly<Record<string, unknown>>;

export const liveDefaultBranchProtection = JSON.parse(
  '{"allow_deletions":{"enabled":false},"allow_force_pushes":{"enabled":false},"allow_fork_syncing":{"enabled":false},"block_creations":{"enabled":false},"enforce_admins":{"enabled":true},"lock_branch":{"enabled":false},"required_conversation_resolution":{"enabled":true},"required_linear_history":{"enabled":true},"required_pull_request_reviews":{"dismiss_stale_reviews":true,"require_code_owner_reviews":false,"require_last_push_approval":false,"required_approving_review_count":0},"required_signatures":{"enabled":false},"required_status_checks":{"checks":[{"app_id":15368,"context":"check"},{"app_id":15368,"context":"pr-title"}],"strict":true}}',
) as Readonly<Record<string, unknown>>;

export const defaultBranchResponse = (path: string): unknown | undefined => {
  if (path === '/repos/owner/repo') {
    return JSON.parse('{"default_branch":"trunk"}') as unknown;
  }
  if (path === '/repos/owner/repo/branches/trunk') {
    return {
      name: 'trunk',
      protected: true,
      protection: { enabled: true },
    };
  }
  return path === '/repos/owner/repo/branches/trunk/protection'
    ? liveDefaultBranchProtection
    : undefined;
};
