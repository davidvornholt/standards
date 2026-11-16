// `standards creds watch`: report brokered Cloudflare tokens across every
// repository that expire within the renewal window, and with --issues keep one
// GitHub issue per affected repository in $GITHUB_REPOSITORY. In CI it reads
// one read-only token per account from STANDARDS_CREDS_WATCH_<account-id>, so
// it never needs the broker bootstrap token that lives only on the operator's
// machines. Without those variables it falls back to the local broker store.

import process from 'node:process';
import { listAccountTokens } from './creds-cloudflare';
import type { AccountToken } from './creds-plan-types';
import { readBrokerStore, resolveBrokerPath } from './creds-store';
import { type DueToken, findDueTokens } from './creds-watch-due';
import { syncExpiryIssues } from './creds-watch-issues';
import { resolveToken } from './github-api';

export const WATCH_TOKEN_PREFIX = 'STANDARDS_CREDS_WATCH_';
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/u;

type WatchAccount = { readonly accountId: string; readonly token: string };

const watchAccounts = async (): Promise<
  | { readonly ok: true; readonly accounts: ReadonlyArray<WatchAccount> }
  | { readonly ok: false; readonly problem: string }
> => {
  const fromEnv = Object.entries(process.env).flatMap(([name, value]) =>
    name.startsWith(WATCH_TOKEN_PREFIX)
      ? [
          {
            accountId: name.slice(WATCH_TOKEN_PREFIX.length),
            token: value ?? '',
          },
        ]
      : [],
  );
  const invalid = fromEnv.find(
    ({ accountId, token }) => !ACCOUNT_ID.test(accountId) || token.length === 0,
  );
  if (invalid !== undefined) {
    return {
      ok: false,
      problem: `${WATCH_TOKEN_PREFIX}${invalid.accountId} must be named by a 32-character lowercase hexadecimal Cloudflare account ID and hold a non-empty token`,
    };
  }
  if (fromEnv.length > 0) {
    return { ok: true, accounts: fromEnv };
  }
  const store = await readBrokerStore(resolveBrokerPath());
  return store.cloudflare.length === 0
    ? {
        ok: false,
        problem: `no Cloudflare account to watch: set ${WATCH_TOKEN_PREFIX}<account-id> to a token with Account API Tokens Read, or configure the broker store with \`standards creds login cloudflare\``,
      }
    : { ok: true, accounts: store.cloudflare };
};

const fail = (message: string): false => {
  console.error(`standards creds: ${message}`);
  return false;
};

type Listed = {
  readonly tokens: ReadonlyArray<AccountToken>;
  readonly problems: ReadonlyArray<string>;
  readonly complete: boolean;
};

const listAll = async (
  accounts: ReadonlyArray<WatchAccount>,
): Promise<Listed> => {
  const listings = await Promise.all(
    accounts.map(async (account) => ({
      account,
      listed: await listAccountTokens(account.accountId, account.token),
    })),
  );
  return {
    tokens: listings.flatMap(({ account, listed }) =>
      listed.ok
        ? listed.value.map((token) => ({ accountId: account.accountId, token }))
        : [],
    ),
    problems: listings.flatMap(({ account, listed }) =>
      listed.ok ? [] : [`account ${account.accountId}: ${listed.problem}`],
    ),
    complete: listings.every(({ listed }) => listed.ok),
  };
};

const printReport = (
  byRepo: ReadonlyMap<string, ReadonlyArray<DueToken>>,
): void => {
  if (byRepo.size === 0) {
    console.log(
      'standards creds: no brokered token expires within the renewal window',
    );
  }
  for (const [repo, due] of byRepo) {
    console.log(`standards creds: ${repo}`);
    for (const token of due) {
      console.log(
        `  ${token.name} ${token.expired ? 'expired' : 'expires'} ${token.expiresOn}`,
      );
    }
  }
};

type IssueTarget = { readonly home: string; readonly token: string };

// With --issues, the repository the issues go to and the token that writes them.
const issueTarget = (
  issues: boolean,
): IssueTarget | null | { readonly problem: string } => {
  if (!issues) {
    return null;
  }
  const home = process.env.GITHUB_REPOSITORY ?? '';
  if (!REPOSITORY.test(home)) {
    return {
      problem: '--issues requires GITHUB_REPOSITORY to name owner/repo',
    };
  }
  const token = resolveToken();
  return token === null
    ? { problem: '--issues requires GH_TOKEN or GITHUB_TOKEN' }
    : { home, token };
};

export const runCredsWatch = async (issues: boolean): Promise<boolean> => {
  const target = issueTarget(issues);
  if (target !== null && 'problem' in target) {
    return fail(target.problem);
  }
  const resolved = await watchAccounts();
  if (!resolved.ok) {
    return fail(resolved.problem);
  }
  const listed = await listAll(resolved.accounts);
  const report = findDueTokens(listed.tokens, new Date());
  printReport(report.byRepo);
  const problems = [...listed.problems, ...report.problems];
  if (target !== null) {
    const synced = await syncExpiryIssues({
      token: target.token,
      home: target.home,
      byRepo: report.byRepo,
      complete: listed.complete,
    });
    for (const line of synced.lines) {
      console.log(`standards creds: ${line}`);
    }
    problems.push(...synced.problems);
  }
  for (const problem of problems) {
    console.error(`standards creds: ${problem}`);
  }
  return problems.length === 0;
};
