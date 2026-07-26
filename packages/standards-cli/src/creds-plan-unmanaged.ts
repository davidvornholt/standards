// Reconciliation matches tokens to a repository by name and used to discard
// every other token in the account silently. That silence is where a forgotten
// credential hides: replacing a hand-made token means minting a brokered one
// and deleting the original, and nothing noticed when the second half was
// skipped. Classification makes the leftovers visible without giving the broker
// any power over them — a token named here is never mutated automatically.

import type { CloudflareToken } from './creds-cloudflare-api';
import {
  type BrokeredTokenRef,
  isInMintedNamespace,
  parseAnyTokenName,
  parseTokenName,
  repoTokenPrefix,
} from './creds-naming';
import type {
  AccountToken,
  BrokeredElsewhereToken,
  UnmanagedToken,
} from './creds-plan-types';

type Classification =
  | { readonly kind: 'managed'; readonly ref: BrokeredTokenRef }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'unmanaged' }
  | { readonly kind: 'brokered-elsewhere'; readonly repo: string }
  | { readonly kind: 'ignored' };

const classifyAccountToken = (
  token: CloudflareToken,
  repo: string,
): Classification => {
  const ref = parseTokenName(token.name, repo);
  if (ref !== null) {
    return { kind: 'managed', ref };
  }
  // An expired token grants nothing, and listing years of them would bury the
  // live ones. Brokered tokens keep their own expiry handling in creds-plan.
  if (token.status === 'expired') {
    return { kind: 'ignored' };
  }
  if (token.name.startsWith(repoTokenPrefix(repo))) {
    return { kind: 'malformed' };
  }
  // A brokered name carries the repository that owns it, which normally
  // reconciles it. That premise fails exactly once: rename, transfer, or delete
  // that repository and no checkout resolves to the old name, so nothing renews
  // the token, nothing revokes it, and no repository would ever mention it.
  // Every account sharer reporting it is the price of the orphan being seen at
  // all. It stays out of the unmanaged bucket, which asserts something else —
  // that the broker mints nothing of this shape anywhere.
  const elsewhere = parseAnyTokenName(token.name);
  if (elsewhere !== null) {
    return { kind: 'brokered-elsewhere', repo: elsewhere.repo };
  }
  return isInMintedNamespace(token.name)
    ? { kind: 'ignored' }
    : { kind: 'unmanaged' };
};

export type ManagedTokenRef = AccountToken & {
  readonly ref: BrokeredTokenRef;
};

export type TokenPartition = {
  readonly managed: ReadonlyArray<ManagedTokenRef>;
  readonly unmanaged: ReadonlyArray<UnmanagedToken>;
  readonly brokeredElsewhere: ReadonlyArray<BrokeredElsewhereToken>;
  readonly findings: ReadonlyArray<string>;
};

const reported = (entry: AccountToken): UnmanagedToken => ({
  accountId: entry.accountId,
  tokenId: entry.token.id,
  name: entry.token.name,
  status: entry.token.status,
});

export const partitionAccountTokens = (
  tokens: ReadonlyArray<AccountToken>,
  repo: string,
): TokenPartition => {
  const managed: Array<ManagedTokenRef> = [];
  const unmanaged: Array<UnmanagedToken> = [];
  const brokeredElsewhere: Array<BrokeredElsewhereToken> = [];
  const findings: Array<string> = [];
  for (const entry of tokens) {
    const classification = classifyAccountToken(entry.token, repo);
    if (classification.kind === 'managed') {
      managed.push({ ...entry, ref: classification.ref });
    } else if (classification.kind === 'malformed') {
      findings.push(
        `${entry.token.name} claims this repository's brokered namespace but is not a name this broker mints; rename it in the dashboard or retire it with \`standards creds revoke --account ${entry.accountId} --token-id ${entry.token.id}\``,
      );
    } else if (classification.kind === 'unmanaged') {
      unmanaged.push(reported(entry));
    } else if (classification.kind === 'brokered-elsewhere') {
      brokeredElsewhere.push({ ...reported(entry), repo: classification.repo });
    }
  }
  return { managed, unmanaged, brokeredElsewhere, findings };
};
