// Cloudflare broker bootstrap. Cloudflare's API can create account-owned
// tokens, but the very first token must come from the dashboard — this is the
// one paste per account, ever. The flow tells the user exactly what to click
// and which single permission to grant, takes the token hidden, verifies it
// against the API before storing, and from then on every real credential is a
// scoped, expiring account token minted by `standards creds add`.

import { openInBrowser } from './creds-browser';
import { listAccountTokens, verifyAccountToken } from './creds-cloudflare';
import type { CfResult } from './creds-cloudflare-api';
import { BROKER_IDENTITY_NAME, isInMintedNamespace } from './creds-naming';
import { promptHidden, promptLine } from './creds-prompt';
import {
  readBrokerStore,
  resolveBrokerPath,
  updateBrokerStore,
} from './creds-store';

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/u;

export const verifyCloudflareBootstrapAuthority = async (
  accountId: string,
  token: string,
): Promise<CfResult<{ readonly tokenName: string }>> => {
  const verified = await verifyAccountToken(accountId, token);
  if (!verified.ok) {
    return {
      ok: false,
      problem: `activity verification failed — ${verified.problem}`,
    };
  }
  if (verified.value.status !== 'active') {
    return {
      ok: false,
      problem: `token status is "${verified.value.status}", not "active"`,
    };
  }
  const listed = await listAccountTokens(accountId, token);
  if (!listed.ok) {
    return {
      ok: false,
      problem: `token cannot list account API tokens — ${listed.problem}; grant Account / Account API Tokens / Edit`,
    };
  }
  const own = listed.value.find((entry) => entry.id === verified.value.id);
  if (own === undefined) {
    return {
      ok: false,
      problem:
        'the verified token was not found in the complete account token list',
    };
  }
  if (isInMintedNamespace(own.name)) {
    return {
      ok: false,
      problem: `the token is named "${own.name}", inside the broker's minted-token namespace — reconciliation would treat it as a minted credential and could revoke it; rename it ${BROKER_IDENTITY_NAME} in the dashboard and re-run login`,
    };
  }
  return { ok: true, value: { tokenName: own.name } };
};

export const runCredsLoginCloudflare = async (options: {
  readonly account: string | undefined;
}): Promise<boolean> => {
  const accountId =
    options.account ??
    (await promptLine(
      'Cloudflare account ID (dash.cloudflare.com, account home, "Account ID" in the sidebar): ',
    ));
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    console.error(
      'standards creds: a Cloudflare account ID is 32 hex characters',
    );
    return false;
  }
  const storePath = resolveBrokerPath();
  const store = await readBrokerStore(storePath);
  if (store.cloudflare.some((entry) => entry.accountId === accountId)) {
    console.error(
      `standards creds: account ${accountId} is already configured; remove its entry from ${storePath} to replace the bootstrap token`,
    );
    return false;
  }
  const tokensUrl = `https://dash.cloudflare.com/${accountId}/api-tokens`;
  console.log('Create the bootstrap token (one time for this account):');
  console.log(`  1. Open ${tokensUrl}`);
  console.log('  2. Select Create Token');
  console.log('  3. Find Create additional tokens and select Use template');
  console.log(`  4. Name it ${BROKER_IDENTITY_NAME}`);
  console.log(
    '  5. Keep exactly one permission: Account / Account API Tokens / Edit',
  );
  console.log('  6. Continue to summary, create the token, and copy the value');
  openInBrowser(tokensUrl);
  const token = await promptHidden('Paste the token (input is hidden): ');
  if (token.length === 0) {
    console.error('standards creds: no token entered');
    return false;
  }
  const verified = await verifyCloudflareBootstrapAuthority(accountId, token);
  if (!verified.ok) {
    console.error(
      `standards creds: token verification failed — ${verified.problem}`,
    );
    return false;
  }
  const { tokenName } = verified.value;
  if (tokenName !== BROKER_IDENTITY_NAME) {
    console.error(
      `standards creds: warning — the token is named "${tokenName}", not "${BROKER_IDENTITY_NAME}"; rename it in the dashboard so it stays identifiable`,
    );
  }
  await updateBrokerStore(storePath, (current) => {
    if (current.cloudflare.some((entry) => entry.accountId === accountId)) {
      throw new Error(
        `Cloudflare account ${accountId} was configured while login was in progress; the newly entered token was not stored`,
      );
    }
    return {
      ...current,
      cloudflare: [...current.cloudflare, { accountId, token }],
    };
  });
  console.log(
    `standards creds: Cloudflare account ${accountId} configured; bootstrap token stored in ${storePath}`,
  );
  return true;
};
