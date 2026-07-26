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
  parseTokenName,
  repoTokenPrefix,
} from './creds-naming';
import type { AccountToken, UnmanagedToken } from './creds-plan-types';

type Classification =
  | { readonly kind: 'managed'; readonly ref: BrokeredTokenRef }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'unmanaged' }
  | { readonly kind: 'ignored' };

export const classifyAccountToken = (
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
  // Another repository's brokered token is reconciled where it belongs, and
  // reporting it in every repository sharing the account would train the
  // operator to skim past the list that matters.
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
  readonly findings: ReadonlyArray<string>;
};

export const partitionAccountTokens = (
  tokens: ReadonlyArray<AccountToken>,
  repo: string,
): TokenPartition => {
  const managed: Array<ManagedTokenRef> = [];
  const unmanaged: Array<UnmanagedToken> = [];
  const findings: Array<string> = [];
  for (const entry of tokens) {
    const classification = classifyAccountToken(entry.token, repo);
    if (classification.kind === 'managed') {
      managed.push({ ...entry, ref: classification.ref });
    } else if (classification.kind === 'malformed') {
      findings.push(
        `${entry.token.name} (${entry.accountId}/${entry.token.id}) claims this repository's brokered namespace but is not a name this broker mints; rename it in the dashboard or retire it with \`standards creds revoke --token-id ${entry.token.id}\``,
      );
    } else if (classification.kind === 'unmanaged') {
      unmanaged.push({
        accountId: entry.accountId,
        tokenId: entry.token.id,
        name: entry.token.name,
        status: entry.token.status,
      });
    }
  }
  return { managed, unmanaged, findings };
};
