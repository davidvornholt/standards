// Shared fixtures for the pure plan-computation suites: a brokered token
// factory with a realistic lifetime and a keysByTarget builder.

import type { CloudflareToken } from './creds-cloudflare-api';

export const REPO = 'davidvornholt/example';
export const NOW = new Date('2026-07-22T00:00:00Z');
const TOKEN_TTL_DAYS = 90;
const DAY_MS = 86_400_000;
export const POLICIES = [
  {
    effect: 'allow' as const,
    resources: { 'com.cloudflare.api.account.a': '*' },
    // biome-ignore lint/style/useNamingConvention: Cloudflare's policy wire field is snake_case.
    permission_groups: [{ id: 'pg' }],
  },
];

export const token = (
  name: string,
  expiresOn: string | null,
): CloudflareToken => ({
  id: `id-${name}`,
  name,
  status: 'active',
  expiresOn,
  issuedOn:
    expiresOn === null
      ? null
      : new Date(Date.parse(expiresOn) - TOKEN_TTL_DAYS * DAY_MS).toISOString(),
  policies: POLICIES,
  condition: { supported: true, value: null },
});

export const keys = (
  entries: Readonly<Record<string, ReadonlyArray<string>>>,
): ReadonlyMap<string, ReadonlySet<string>> =>
  new Map(
    Object.entries(entries).map(([target, list]) => [target, new Set(list)]),
  );
