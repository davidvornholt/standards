// Permission-group and token-policy resolution for `standards creds add
// cloudflare`. The scope gates are cheap preconditions mirroring provider
// ground truth: a policy resource only accepts permission groups whose
// reported scopes include it, so incompatible selections fail here with the
// group names instead of failing at token creation.

import { listPermissionGroups } from './creds-cloudflare';
import type { PermissionGroup, TokenPolicy } from './creds-cloudflare-api';
import { isR2BucketName, R2_BUCKET_SCOPE, r2BucketResource } from './creds-r2';
import type { CloudflareBrokerAccount } from './creds-store';

const ACCOUNT_SCOPE = 'com.cloudflare.api.account';

export const unsupportedResourceScopes = (
  groups: ReadonlyArray<PermissionGroup>,
  scope: string,
): ReadonlyArray<string> =>
  groups
    .filter((group) => !group.scopes.includes(scope))
    .map((group) => group.name);

const scopeProblem = (
  bucket: string | undefined,
  selected: ReadonlyArray<PermissionGroup>,
): string | null => {
  const scope = bucket === undefined ? ACCOUNT_SCOPE : R2_BUCKET_SCOPE;
  const unsupported = unsupportedResourceScopes(selected, scope);
  if (unsupported.length === 0) {
    return null;
  }
  return bucket === undefined
    ? `permission group(s) ${unsupported.join(', ')} cannot target an account resource; choose account-scoped groups (zone-scoped groups require an explicit zone resource, which this command does not yet support, and R2 bucket-item groups require --bucket)`
    : `permission group(s) ${unsupported.join(', ')} cannot target an R2 bucket resource; --bucket accepts only bucket-scoped groups such as Workers R2 Storage Bucket Item Read/Write`;
};

export type ResolvedTokenPolicy =
  | {
      readonly ok: true;
      readonly policy: TokenPolicy;
      readonly wanted: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly problem: string };

export const resolveTokenPolicy = async (
  account: CloudflareBrokerAccount,
  options: {
    readonly permissions: string | undefined;
    readonly bucket: string | undefined;
  },
): Promise<ResolvedTokenPolicy> => {
  if (options.permissions === undefined || options.permissions.length === 0) {
    return {
      ok: false,
      problem:
        '--permissions "<Group Name>[,<Group Name>...]" is required; list names with `standards creds permissions`',
    };
  }
  if (options.bucket !== undefined && !isR2BucketName(options.bucket)) {
    return {
      ok: false,
      problem: `invalid R2 bucket name: ${options.bucket} (3-63 lowercase letters, digits, and hyphens)`,
    };
  }
  const groups = await listPermissionGroups(account.accountId, account.token);
  if (!groups.ok) {
    return { ok: false, problem: groups.problem };
  }
  const wanted = options.permissions
    .split(',')
    .map((groupName) => groupName.trim());
  const resolved = wanted.map((name) => ({
    name,
    group: groups.value.find(
      (group) => group.name.toLowerCase() === name.toLowerCase(),
    ),
  }));
  const unknown = resolved.flatMap(({ name, group }) =>
    group === undefined ? [name] : [],
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      problem: `unknown permission group(s): ${unknown.join(', ')}; list names with \`standards creds permissions\``,
    };
  }
  const selected = resolved.flatMap(({ group }) =>
    group === undefined ? [] : [group],
  );
  const problem = scopeProblem(options.bucket, selected);
  if (problem !== null) {
    return { ok: false, problem };
  }
  const resource =
    options.bucket === undefined
      ? `${ACCOUNT_SCOPE}.${account.accountId}`
      : r2BucketResource(account.accountId, options.bucket);
  return {
    ok: true,
    wanted,
    policy: {
      effect: 'allow',
      resources: { [resource]: '*' },
      // biome-ignore lint/style/useNamingConvention: Cloudflare's policy wire field is snake_case.
      permission_groups: selected.map(({ id }) => ({ id })),
    },
  };
};
