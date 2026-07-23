// Shared destination resolution for `standards creds add`: parse the
// <target>:<dotted.key> destination, resolve the repository and SOPS target,
// and select the Cloudflare account to operate on.

import { resolveTargetRel } from './creds-sops';
import {
  type BrokerStore,
  type CloudflareBrokerAccount,
  readBrokerStore,
  resolveBrokerPath,
} from './creds-store';
import { resolveGithubRepo } from './github-api';

export type CredsDestination = {
  readonly target: string;
  readonly key: string;
};

export const parseDestination = (raw: string): CredsDestination | null => {
  const separator = raw.indexOf(':');
  if (separator <= 0 || separator === raw.length - 1) {
    return null;
  }
  return { target: raw.slice(0, separator), key: raw.slice(separator + 1) };
};

export type ResolvedContext = {
  readonly repo: string;
  readonly rel: string;
  readonly dest: CredsDestination;
  readonly store: BrokerStore;
};

export const resolveContext = async (
  consumer: string,
  destRaw: string | undefined,
): Promise<ResolvedContext | null> => {
  if (destRaw === undefined) {
    console.error(
      'standards creds: --dest <target>:<dotted.key> is required (e.g. --dest ci:ci.cloudflare_dns_token)',
    );
    return null;
  }
  const dest = parseDestination(destRaw);
  if (dest === null) {
    console.error(`standards creds: invalid --dest value: ${destRaw}`);
    return null;
  }
  const repo = resolveGithubRepo(consumer);
  if (repo === null) {
    console.error(
      'standards creds: cannot resolve the GitHub repository from the origin remote',
    );
    return null;
  }
  const rel = resolveTargetRel(consumer, dest.target);
  if (rel === null) {
    console.error(
      `standards creds: secrets target "${dest.target}" not found; create it with \`just secrets edit ${dest.target}\` first`,
    );
    return null;
  }
  return { repo, rel, dest, store: await readBrokerStore(resolveBrokerPath()) };
};

export const selectAccount = (
  store: BrokerStore,
  accountId: string | undefined,
): CloudflareBrokerAccount | null => {
  if (store.cloudflare.length === 0) {
    console.error(
      'standards creds: no Cloudflare accounts configured; run `standards creds login cloudflare`',
    );
    return null;
  }
  if (accountId === undefined) {
    if (store.cloudflare.length === 1) {
      return store.cloudflare[0] ?? null;
    }
    console.error(
      `standards creds: multiple Cloudflare accounts configured; pass --account (${store.cloudflare.map((entry) => entry.accountId).join(', ')})`,
    );
    return null;
  }
  const account = store.cloudflare.find(
    (entry) => entry.accountId === accountId,
  );
  if (account === undefined) {
    console.error(`standards creds: account ${accountId} is not configured`);
  }
  return account ?? null;
};
