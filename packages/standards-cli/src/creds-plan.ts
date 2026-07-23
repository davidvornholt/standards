// Pure reconciliation between a repository's SOPS key structure and the
// Cloudflare tokens the broker minted for it (matched by the deterministic
// naming scheme). A brokered token whose secret key vanished from SOPS is
// revoked; one nearing expiry is rolled and its new value written back into
// the SOPS target. Secret keys without a brokered token are simply unmanaged
// — most secrets are — and are never touched. Execution lives in
// creds-plan-run.ts.

import type { CloudflareToken } from './creds-cloudflare-api';
import { parseTokenName } from './creds-naming';

const DEFAULT_RENEW_WITHIN_DAYS = 30;
const DAY_MS = 86_400_000;

export type AccountToken = {
  readonly accountId: string;
  readonly token: CloudflareToken;
};

export type PlannedAction =
  | {
      readonly kind: 'revoke';
      readonly accountId: string;
      readonly tokenId: string;
      readonly name: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'roll';
      readonly accountId: string;
      readonly tokenId: string;
      readonly name: string;
      readonly target: string;
      readonly key: string;
      readonly reason: string;
    };

export type CredsPlan = {
  readonly actions: ReadonlyArray<PlannedAction>;
  readonly healthy: number;
};

export const computeCredsPlan = (input: {
  readonly repo: string;
  readonly keysByTarget: ReadonlyMap<string, ReadonlySet<string>>;
  readonly tokens: ReadonlyArray<AccountToken>;
  readonly now: Date;
  readonly renewWithinDays?: number;
}): CredsPlan => {
  const renewWithin =
    (input.renewWithinDays ?? DEFAULT_RENEW_WITHIN_DAYS) * DAY_MS;
  const actions: Array<PlannedAction> = [];
  let healthy = 0;
  for (const { accountId, token } of input.tokens) {
    const ref = parseTokenName(token.name, input.repo);
    if (ref !== null) {
      const base = { accountId, tokenId: token.id, name: token.name };
      const expiry =
        token.expiresOn === null ? null : Date.parse(token.expiresOn);
      if (!input.keysByTarget.get(ref.target)?.has(ref.key)) {
        actions.push({
          ...base,
          kind: 'revoke',
          reason: `secret ${ref.target}:${ref.key} no longer exists`,
        });
      } else if (
        expiry !== null &&
        expiry - input.now.getTime() <= renewWithin
      ) {
        actions.push({
          ...base,
          kind: 'roll',
          target: ref.target,
          key: ref.key,
          reason: `expires ${token.expiresOn}`,
        });
      } else {
        healthy += 1;
      }
    }
  }
  return { actions, healthy };
};
