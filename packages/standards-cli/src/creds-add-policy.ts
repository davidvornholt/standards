// Permission-group and token-policy resolution for `standards creds add
// cloudflare`. The scope gates are cheap preconditions mirroring provider
// ground truth: a policy resource only accepts permission groups whose
// reported scopes include it, so incompatible selections fail here with the
// group names instead of failing at token creation.

import { listPermissionGroups } from './creds-cloudflare';
import type { PermissionGroup, TokenPolicy } from './creds-cloudflare-api';
import { ZONE_SCOPE, zoneResource } from './creds-cloudflare-zone';
import {
  DEFAULT_R2_JURISDICTION,
  isR2BucketName,
  R2_BUCKET_SCOPE,
  type R2Jurisdiction,
  r2BucketResource,
} from './creds-r2';
import type { CloudflareBrokerAccount } from './creds-store';

const ACCOUNT_SCOPE = 'com.cloudflare.api.account';

const tokenPolicy = (
  resources: TokenPolicy['resources'],
  groups: ReadonlyArray<PermissionGroup>,
): TokenPolicy => ({
  effect: 'allow',
  resources,
  // biome-ignore lint/style/useNamingConvention: Cloudflare's policy wire field is snake_case.
  permission_groups: groups.map(({ id }) => ({ id })),
});

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
    ? `permission group(s) ${unsupported.join(', ')} cannot target an account resource; choose account-scoped groups, name the zones with --zone for zone-scoped groups, or pass --bucket for R2 bucket-item groups`
    : `permission group(s) ${unsupported.join(', ')} cannot target an R2 bucket resource; --bucket accepts only bucket-scoped groups such as Workers R2 Storage Bucket Item Read/Write`;
};

// With zones named, a token spans two resources, so the selection is split by
// what each group can actually target rather than checked against one scope.
// A group matching neither resource is the operator's mistake and is named.
const zonePolicies = (
  accountId: string,
  zoneIds: ReadonlyArray<string>,
  selected: ReadonlyArray<PermissionGroup>,
):
  | { readonly policies: ReadonlyArray<TokenPolicy> }
  | { readonly problem: string } => {
  const zoneGroups = selected.filter((group) =>
    group.scopes.includes(ZONE_SCOPE),
  );
  const accountGroups = selected.filter(
    (group) =>
      !group.scopes.includes(ZONE_SCOPE) &&
      group.scopes.includes(ACCOUNT_SCOPE),
  );
  const unsupported = selected
    .filter(
      (group) =>
        !(
          group.scopes.includes(ZONE_SCOPE) ||
          group.scopes.includes(ACCOUNT_SCOPE)
        ),
    )
    .map((group) => group.name);
  if (unsupported.length > 0) {
    return {
      problem: `permission group(s) ${unsupported.join(', ')} target neither a zone nor an account resource; R2 bucket-item groups require --bucket, which cannot be combined with --zone`,
    };
  }
  if (zoneGroups.length === 0) {
    return {
      problem:
        '--zone was given but no selected permission group is zone-scoped; drop --zone, or add a zone-scoped group such as DNS Write',
    };
  }
  const zoneResources = Object.fromEntries(
    zoneIds.map((zoneId) => [zoneResource(zoneId), '*']),
  );
  return {
    policies: [
      ...(accountGroups.length === 0
        ? []
        : [
            tokenPolicy(
              { [`${ACCOUNT_SCOPE}.${accountId}`]: '*' },
              accountGroups,
            ),
          ]),
      tokenPolicy(zoneResources, zoneGroups),
    ],
  };
};

export type ResolvedTokenPolicy =
  | {
      readonly ok: true;
      readonly policies: ReadonlyArray<TokenPolicy>;
      readonly wanted: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly problem: string };

export const resolveTokenPolicy = async (
  account: CloudflareBrokerAccount,
  options: {
    readonly permissions: string | undefined;
    readonly bucket: string | undefined;
    readonly zoneIds?: ReadonlyArray<string>;
    readonly jurisdiction?: R2Jurisdiction;
  },
): Promise<ResolvedTokenPolicy> => {
  const zoneIds = options.zoneIds ?? [];
  if (options.permissions === undefined || options.permissions.length === 0) {
    return {
      ok: false,
      problem:
        '--permissions "<Group Name>[,<Group Name>...]" is required; list names with `standards creds permissions`',
    };
  }
  if (options.bucket !== undefined && zoneIds.length > 0) {
    return {
      ok: false,
      problem:
        '--bucket and --zone cannot be combined; an R2 bucket credential and a zone credential are separate tokens',
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
  if (zoneIds.length > 0) {
    const zoned = zonePolicies(account.accountId, zoneIds, selected);
    return 'problem' in zoned
      ? { ok: false, problem: zoned.problem }
      : { ok: true, wanted, policies: zoned.policies };
  }
  const problem = scopeProblem(options.bucket, selected);
  if (problem !== null) {
    return { ok: false, problem };
  }
  const resource =
    options.bucket === undefined
      ? `${ACCOUNT_SCOPE}.${account.accountId}`
      : r2BucketResource(
          account.accountId,
          options.bucket,
          options.jurisdiction ?? DEFAULT_R2_JURISDICTION,
        );
  return {
    ok: true,
    wanted,
    policies: [tokenPolicy({ [resource]: '*' }, selected)],
  };
};
