// One-shot retirement of a Cloudflare token the broker does not manage, named
// explicitly by ID. Replacing a hand-made credential means minting a brokered
// one and deleting the original; without this the second half could only be
// done in the dashboard. The power granted is deliberately momentary: nothing
// is recorded, nothing becomes automatic, and a human names the target every
// time. Tokens reconciliation owns are refused — those are retired by deleting
// their SOPS key and running `standards creds apply`, which keeps the secret
// and the provider in step.

import { deleteAccountToken } from './creds-cloudflare';
import { isCloudflareId } from './creds-cloudflare-id';
import { selectAccount } from './creds-dest';
import { identifyCloudflareBootstrapAuthority } from './creds-login-cloudflare';
import {
  BROKER_IDENTITY_NAME,
  type BrokeredTokenRef,
  parseAnyTokenName,
} from './creds-naming';
import { readBrokerStore, resolveBrokerPath } from './creds-store';
import { resolveGithubRepo } from './github-api';

const fail = (message: string): false => {
  console.error(`standards creds: ${message}`);
  return false;
};

// GitHub owner and repository names are case-insensitive, so a checkout cloned
// as `DavidVornholt/Example` owns the token minted as `davidvornholt/example`.
// An exact comparison would call that token foreign and let --force delete a
// live credential this very checkout reconciles.
const sameRepo = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

// A brokered name carries the repository that owns it, and the reconciled
// remedy — delete the SOPS key, run `apply` — only works in that repository.
// Naming a bare `<target>:<key>` to an operator standing somewhere else would
// have them destroy their own live credential of the same name, so the owning
// repository is always named and the remedy is placed where it runs.
const brokeredRefusal = ({
  tokenId,
  name,
  brokered,
  currentRepo,
  force,
}: {
  readonly tokenId: string;
  readonly name: string;
  readonly brokered: BrokeredTokenRef;
  readonly currentRepo: string | null;
  readonly force: boolean;
}): string | null => {
  // Without a repository here, the one thing --force claims to override — that
  // this checkout is not the owner — is the thing that could not be checked,
  // so the override is refused rather than granted on an unevaluated guard.
  if (currentRepo === null) {
    return `token ${tokenId} is brokered as ${name}, which belongs to ${brokered.repo}, and this checkout cannot resolve the GitHub repository from its origin remote, so whether this checkout owns the token could not be determined; --force does not override a check that never ran. Re-run from a checkout whose origin remote names a GitHub repository, or point --dir at one. If ${brokered.repo} still exists, the remedy runs there: delete ${brokered.target}:${brokered.key} from its SOPS target and run \`standards creds apply\` in that checkout`;
  }
  if (sameRepo(brokered.repo, currentRepo)) {
    return `token ${tokenId} is brokered as ${name} for this repository (${brokered.repo}); delete ${brokered.target}:${brokered.key} from this repository's SOPS target and run \`standards creds apply\`, which revokes it and keeps the secret in step`;
  }
  if (force) {
    return null;
  }
  return `token ${tokenId} is brokered as ${name}, which belongs to ${brokered.repo}, and this checkout is ${currentRepo}; the remedy runs there: delete ${brokered.target}:${brokered.key} from ${brokered.repo}'s SOPS target and run \`standards creds apply\` in that checkout. Pass --force only if ${brokered.repo} was renamed, transferred, or deleted, so no checkout resolves to that name and no apply will ever revoke this token`;
};

export const runCredsRevoke = async (options: {
  readonly account: string | undefined;
  readonly tokenId: string | undefined;
  readonly dir: string;
  readonly force: boolean;
}): Promise<boolean> => {
  const { tokenId } = options;
  if (tokenId === undefined) {
    return fail(
      'revoke requires --token-id <id>; `standards creds plan` prints the ID inside every revoke command it offers, and the Cloudflare dashboard has the ID of anything that listing leaves out',
    );
  }
  if (!isCloudflareId(tokenId)) {
    return fail(
      `not a token ID: ${tokenId}; --token-id takes the 32-character hexadecimal token ID`,
    );
  }
  const store = await readBrokerStore(resolveBrokerPath());
  const account = selectAccount(store, options.account);
  if (account === null) {
    return false;
  }
  const identified = await identifyCloudflareBootstrapAuthority(
    account.accountId,
    account.token,
  );
  if (!identified.ok) {
    return fail(`account ${account.accountId}: ${identified.problem}`);
  }
  // The bootstrap token is matched by its verified ID rather than its name,
  // because deleting it would strip the broker of every power it has and no
  // rename should be able to disguise it.
  if (identified.value.id === tokenId) {
    return fail(
      `token ${tokenId} is this account's broker bootstrap credential; revoking it would leave the broker unable to mint or reconcile anything`,
    );
  }
  const target = identified.value.tokens.find((entry) => entry.id === tokenId);
  if (target === undefined) {
    return fail(
      `no token ${tokenId} in account ${account.accountId}; revoke names a token in the account the bootstrap credential belongs to`,
    );
  }
  // The broker store is machine-global and `creds login` is a per-machine
  // bootstrap, so one account can hold several tokens under the reserved name
  // — one per machine. Only this machine's is identified by ID above; the rest
  // are refused by name, because deleting one locks another machine out of the
  // account and the broker cannot re-mint its own root credential.
  if (target.name === BROKER_IDENTITY_NAME) {
    return fail(
      `token ${tokenId} is named ${BROKER_IDENTITY_NAME}, the reserved name for a machine's broker bootstrap credential; this machine's own bootstrap is a different token, so this one belongs to another machine or is a superseded one — retire it in the Cloudflare dashboard, where you can confirm which machine it belongs to`,
    );
  }
  const brokered = parseAnyTokenName(target.name);
  if (brokered !== null) {
    const refusal = brokeredRefusal({
      tokenId,
      name: target.name,
      brokered,
      currentRepo: resolveGithubRepo(options.dir),
      force: options.force,
    });
    if (refusal !== null) {
      return fail(refusal);
    }
  }
  const deleted = await deleteAccountToken(
    account.accountId,
    account.token,
    tokenId,
  );
  if (!deleted.ok) {
    return fail(`${target.name}: ${deleted.problem}`);
  }
  console.log(
    `standards creds: revoked ${target.name} (${account.accountId}/${tokenId})`,
  );
  if (brokered !== null) {
    console.log(
      `  it was brokered to ${brokered.repo}; --force took it because this checkout is not that repository`,
    );
  }
  console.log(
    '  any stored copy of its value is now dead; replace it with `standards creds add cloudflare` if something still needs it',
  );
  return true;
};
