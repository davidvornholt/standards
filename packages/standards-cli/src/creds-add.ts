import { commitCreatedCloudflareToken } from './creds-add-cloudflare-commit';
import {
  createAccountToken,
  listAccountTokens,
  listPermissionGroups,
} from './creds-cloudflare';
import type { PermissionGroup } from './creds-cloudflare-api';
import { resolveContext, selectAccount } from './creds-dest';
import { tokenNameOf } from './creds-naming';
import { inspectSopsScalarDestination, setSopsValue } from './creds-sops';

const DEFAULT_TTL_DAYS = 90;
const DAY_MS = 86_400_000;
const ACCOUNT_SCOPE = 'com.cloudflare.api.account';

export const unsupportedAccountScopes = (
  groups: ReadonlyArray<PermissionGroup>,
): ReadonlyArray<string> =>
  groups
    .filter((group) => !group.scopes.includes(ACCOUNT_SCOPE))
    .map((group) => group.name);

const resolveWantedGroups = (
  names: ReadonlyArray<string>,
  available: ReadonlyArray<PermissionGroup>,
): {
  readonly selected: ReadonlyArray<PermissionGroup>;
  readonly unknown: ReadonlyArray<string>;
} => {
  const resolved = names.map((name) => ({
    name,
    group: available.find(
      (group) => group.name.toLowerCase() === name.toLowerCase(),
    ),
  }));
  return {
    selected: resolved.flatMap(({ group }) =>
      group === undefined ? [] : [group],
    ),
    unknown: resolved.flatMap(({ name, group }) =>
      group === undefined ? [name] : [],
    ),
  };
};

const printSuccess = (
  name: string,
  permissions: ReadonlyArray<string>,
  expiresOn: string,
  destination: string,
): void => {
  console.log(`standards creds: minted Cloudflare token ${name}`);
  console.log(`  permissions: ${permissions.join(', ')}`);
  console.log(`  expires: ${expiresOn} (rotate via \`standards creds apply\`)`);
  console.log(`  value written to ${destination}`);
};

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
  const destination = await inspectSopsScalarDestination(
    consumer,
    context.rel,
    context.dest.key,
  );
  if (!destination.ok) {
    console.error(`standards creds: ${destination.problem}`);
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
  const { selected, unknown } = resolveWantedGroups(wanted, groups.value);
  if (unknown.length > 0) {
    console.error(
      `standards creds: unknown permission group(s): ${unknown.join(', ')}; list names with \`standards creds permissions\``,
    );
    return false;
  }
  const unsupported = unsupportedAccountScopes(selected);
  if (unsupported.length > 0) {
    console.error(
      `standards creds: permission group(s) ${unsupported.join(', ')} cannot target an account resource; choose account-scoped groups (zone-scoped groups require an explicit zone resource, which this command does not yet support)`,
    );
    return false;
  }
  const name = tokenNameOf({ ...context.dest, repo: context.repo });
  const listings = await Promise.all(
    context.store.cloudflare.map(async (configured) => ({
      accountId: configured.accountId,
      listed: await listAccountTokens(configured.accountId, configured.token),
    })),
  );
  const failedListing = listings.find(({ listed }) => !listed.ok);
  if (failedListing?.listed.ok === false) {
    console.error(
      `standards creds: account ${failedListing.accountId}: ${failedListing.listed.problem}; cannot prove the destination is unambiguous`,
    );
    return false;
  }
  const collisions = listings.flatMap(({ accountId, listed }) =>
    listed.ok && listed.value.some((token) => token.name === name)
      ? [accountId]
      : [],
  );
  if (collisions.length > 0) {
    console.error(
      `standards creds: token ${name} already exists in Cloudflare account(s) ${collisions.join(', ')}; one SOPS destination may be managed by only one account`,
    );
    return false;
  }
  const ttlDays = options.ttlDays ?? DEFAULT_TTL_DAYS;
  const expiresOn = new Date(Date.now() + ttlDays * DAY_MS).toISOString();
  const created = await createAccountToken(account.accountId, account.token, {
    name,
    expiresOn,
    condition: null,
    policies: [
      {
        effect: 'allow',
        resources: { [`com.cloudflare.api.account.${account.accountId}`]: '*' },
        permission_groups: selected.map(({ id }) => ({ id })),
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
  const committed = await commitCreatedCloudflareToken({
    consumer,
    rel: context.rel,
    key: context.dest.key,
    value: created.value.value,
    written,
    accountId: account.accountId,
    bootstrapToken: account.token,
    tokenId: created.value.id,
    name,
  });
  if (!committed.ok) {
    console.error(`standards creds: ${committed.problem}`);
    return false;
  }
  printSuccess(
    name,
    wanted,
    expiresOn,
    `${context.rel} at ${context.dest.key}`,
  );
  return true;
};
