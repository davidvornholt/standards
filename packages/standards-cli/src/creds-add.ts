// `standards creds add cloudflare`: mint a scoped, expiring account token and
// write its value straight into a SOPS target. The command prints only
// metadata (name, expiry, scopes); the secret value flows API-to-SOPS
// without touching stdout or argv. The provider-side token name doubles as
// the reconciliation record — there is no separate manifest to maintain.

import {
  createAccountToken,
  listAccountTokens,
  listPermissionGroups,
} from './creds-cloudflare';
import { resolveContext, selectAccount } from './creds-dest';
import { tokenNameOf } from './creds-naming';
import { setSopsValue } from './creds-sops';

const DEFAULT_TTL_DAYS = 90;
const DAY_MS = 86_400_000;

export const runCredsAddCloudflare = async (
  consumer: string,
  options: {
    readonly dest: string | undefined;
    readonly permissions: string | undefined;
    readonly account: string | undefined;
    readonly ttlDays: number | undefined;
  },
): Promise<boolean> => {
  const context = await resolveContext(consumer, options.dest);
  if (context === null) {
    return false;
  }
  if (options.permissions === undefined || options.permissions.length === 0) {
    console.error(
      'standards creds: --permissions "<Group Name>[,<Group Name>...]" is required; list names with `standards creds permissions`',
    );
    return false;
  }
  const account = selectAccount(context.store, options.account);
  if (account === null) {
    return false;
  }
  const groups = await listPermissionGroups(account.accountId, account.token);
  if (!groups.ok) {
    console.error(`standards creds: ${groups.problem}`);
    return false;
  }
  const wanted = options.permissions
    .split(',')
    .map((groupName) => groupName.trim());
  const resolved = wanted.map((groupName) => ({
    name: groupName,
    group: groups.value.find(
      (group) => group.name.toLowerCase() === groupName.toLowerCase(),
    ),
  }));
  const unknown = resolved.filter((entry) => entry.group === undefined);
  if (unknown.length > 0) {
    console.error(
      `standards creds: unknown permission group(s): ${unknown.map((entry) => entry.name).join(', ')}; list names with \`standards creds permissions\``,
    );
    return false;
  }
  const name = tokenNameOf({ ...context.dest, repo: context.repo });
  const existing = await listAccountTokens(account.accountId, account.token);
  if (!existing.ok) {
    console.error(`standards creds: ${existing.problem}`);
    return false;
  }
  if (existing.value.some((token) => token.name === name)) {
    console.error(
      `standards creds: a token named ${name} already exists; \`standards creds apply\` rotates it, or remove the secret key and apply to revoke it first`,
    );
    return false;
  }
  const ttlDays = options.ttlDays ?? DEFAULT_TTL_DAYS;
  const expiresOn = new Date(Date.now() + ttlDays * DAY_MS).toISOString();
  const created = await createAccountToken(account.accountId, account.token, {
    name,
    expiresOn,
    policies: [
      {
        effect: 'allow',
        resources: { [`com.cloudflare.api.account.${account.accountId}`]: '*' },
        permission_groups: resolved.map((entry) => ({
          id: entry.group?.id ?? '',
        })),
      },
    ],
  });
  if (!created.ok) {
    console.error(`standards creds: ${created.problem}`);
    return false;
  }
  const written = setSopsValue(
    consumer,
    context.rel,
    context.dest.key,
    created.value.value,
  );
  if (!written.ok) {
    console.error(
      `standards creds: token ${name} was created, but ${written.problem}; write it into ${context.rel} manually or delete token ${created.value.id} and retry`,
    );
    return false;
  }
  console.log(`standards creds: minted Cloudflare token ${name}`);
  console.log(`  permissions: ${wanted.join(', ')}`);
  console.log(`  expires: ${expiresOn} (rotate via \`standards creds apply\`)`);
  console.log(`  value written to ${context.rel} at ${context.dest.key}`);
  return true;
};
