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
import { parseAnyTokenName } from './creds-naming';
import { readBrokerStore, resolveBrokerPath } from './creds-store';

const fail = (message: string): false => {
  console.error(`standards creds: ${message}`);
  return false;
};

export const runCredsRevoke = async (options: {
  readonly account: string | undefined;
  readonly tokenId: string | undefined;
}): Promise<boolean> => {
  const { tokenId } = options;
  if (tokenId === undefined) {
    return fail(
      'revoke requires --token-id <id>; `standards creds plan` lists the ID of every token in the account the broker did not mint',
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
  const brokered = parseAnyTokenName(target.name);
  if (brokered !== null) {
    return fail(
      `token ${tokenId} is brokered as ${target.name}; delete ${brokered.target}:${brokered.key} from the SOPS target and run \`standards creds apply\`, which revokes it and keeps the secret in step`,
    );
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
  console.log(
    '  any stored copy of its value is now dead; replace it with `standards creds add cloudflare` if something still needs it',
  );
  return true;
};
