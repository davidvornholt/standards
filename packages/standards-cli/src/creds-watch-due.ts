// Which brokered tokens need renewal, read from Cloudflare's own token list.
// The watcher holds only a read-only token per account, never the broker
// bootstrap token, so it can run unattended in CI. It sees every repository's
// tokens at once because the minted name carries the repository.

import { DAY_MS, RENEW_WITHIN_DAYS } from './creds-cloudflare-expiry';
import { parseAnyTokenName } from './creds-naming';
import type { AccountToken } from './creds-plan-types';

export type DueToken = {
  readonly accountId: string;
  readonly tokenId: string;
  readonly name: string;
  readonly repo: string;
  readonly expiresOn: string;
  readonly expired: boolean;
};

export type DueReport = {
  // Repositories in name order, each with its due tokens soonest first.
  readonly byRepo: ReadonlyMap<string, ReadonlyArray<DueToken>>;
  readonly problems: ReadonlyArray<string>;
};

type Parsed = AccountToken & { readonly repo: string; readonly expiry: number };

// A disabled token may be deliberate, and `creds apply` reports it as a
// finding, so only active and expired tokens are the watcher's concern.
// Active tokens without an expiry never need renewal.
const parse = (
  entry: AccountToken,
): Parsed | { readonly problem: string } | null => {
  const ref = parseAnyTokenName(entry.token.name);
  const { status, expiresOn } = entry.token;
  if (
    ref === null ||
    !(status === 'active' || status === 'expired') ||
    (status === 'active' && expiresOn === null)
  ) {
    return null;
  }
  const expiry = expiresOn === null ? Number.NaN : Date.parse(expiresOn);
  if (!Number.isFinite(expiry)) {
    return {
      problem: `${entry.token.name} (${entry.accountId}/${entry.token.id}) has status ${status} but no valid expires_on value`,
    };
  }
  return { ...entry, repo: ref.repo.toLowerCase(), expiry };
};

export const findDueTokens = (
  tokens: ReadonlyArray<AccountToken>,
  now: Date,
): DueReport => {
  const problems: Array<string> = [];
  const parsed: Array<Parsed> = [];
  for (const entry of tokens) {
    const result = parse(entry);
    if (result !== null && 'problem' in result) {
      problems.push(result.problem);
    } else if (result !== null) {
      parsed.push(result);
    }
  }
  const horizon = now.getTime() + RENEW_WITHIN_DAYS * DAY_MS;
  // A same-name token that is active past the horizon has already replaced
  // the due one, whose leftover `creds revoke` or its own expiry retires.
  const renewed = new Set(
    parsed
      .filter(
        (entry) => entry.token.status === 'active' && entry.expiry > horizon,
      )
      .map((entry) => `${entry.accountId}/${entry.token.name.toLowerCase()}`),
  );
  const due = parsed
    .filter(
      (entry) =>
        entry.expiry <= horizon &&
        !renewed.has(`${entry.accountId}/${entry.token.name.toLowerCase()}`),
    )
    .sort(
      (a, b) =>
        a.repo.localeCompare(b.repo) ||
        a.expiry - b.expiry ||
        a.token.name.localeCompare(b.token.name),
    );
  const byRepo = new Map<string, Array<DueToken>>();
  for (const entry of due) {
    const list = byRepo.get(entry.repo) ?? [];
    list.push({
      accountId: entry.accountId,
      tokenId: entry.token.id,
      name: entry.token.name,
      repo: entry.repo,
      expiresOn: new Date(entry.expiry).toISOString(),
      expired:
        entry.token.status === 'expired' || entry.expiry <= now.getTime(),
    });
    byRepo.set(entry.repo, list);
  }
  return { byRepo, problems };
};
