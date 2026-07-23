import {
  createAccountToken as createToken,
  deleteAccountToken as deleteToken,
} from './creds-cloudflare';
import { listSecretsTargets, resolveTargetRel } from './creds-dest';
import { identifyCloudflareBootstrapAuthority } from './creds-login-cloudflare';
import {
  type AccountToken,
  computeCredsPlan,
  type PlannedAction,
} from './creds-plan';
import { revokePlannedToken } from './creds-plan-revoke';
import {
  inspectSopsScalarDestination as inspectDestination,
  readEncryptedKeys,
  verifySopsStoredValue as verifyStoredValue,
  setSopsValue as writeValue,
} from './creds-sops';
import {
  type BrokerStore,
  type CloudflareBrokerAccount,
  readBrokerStore,
  resolveBrokerPath,
} from './creds-store';
import { resolveGithubRepo } from './github-api';

const gatherRepoState = async (consumer: string, store: BrokerStore) => {
  const keysByTarget = new Map<string, ReadonlySet<string>>();
  const targetKeys = await Promise.all(
    listSecretsTargets(consumer).map(async ({ target, rel }) => ({
      target,
      rel,
      keys: await readEncryptedKeys(consumer, rel),
    })),
  );
  const problems: Array<string> = [];
  for (const { target, rel, keys } of targetKeys) {
    if (keys.ok) {
      keysByTarget.set(target, new Set(keys.keys));
    } else {
      problems.push(`${rel}: ${keys.problem}`);
    }
  }
  const tokens: Array<AccountToken> = [];
  const listings = await Promise.all(
    store.cloudflare.map(async (account) => ({
      account,
      identified: await identifyCloudflareBootstrapAuthority(
        account.accountId,
        account.token,
      ),
    })),
  );
  for (const { account, identified } of listings) {
    if (identified.ok) {
      tokens.push(
        ...identified.value.tokens
          .filter((token) => token.id !== identified.value.id)
          .map((token) => ({
            accountId: account.accountId,
            token,
          })),
      );
    } else {
      problems.push(`account ${account.accountId}: ${identified.problem}`);
    }
  }
  return { keysByTarget, tokens, problems };
};

const cleanupReplacement = async (
  account: CloudflareBrokerAccount,
  replacementId: string,
  oldId: string,
  context: string,
): Promise<string> => {
  const { accountId, token } = account;
  const cleanup = await deleteToken(accountId, token, replacementId);
  return cleanup.ok
    ? `${context}; deleted replacement ${replacementId} and preserved old token ${oldId}`
    : `${context}; cleanup of replacement ${replacementId} also failed: ${cleanup.problem}; old token ${oldId} remains active`;
};

const applyAction = async (
  consumer: string,
  store: BrokerStore,
  action: PlannedAction,
): Promise<string | null> => {
  const account = store.cloudflare.find(
    (entry) => entry.accountId === action.accountId,
  );
  if (account === undefined) {
    return `${action.name}: account ${action.accountId} is not in the broker store`;
  }
  const { accountId, token: bootstrapToken } = account;
  if (action.kind === 'revoke') {
    return revokePlannedToken(account, action);
  }
  const rel = resolveTargetRel(consumer, action.target);
  if (rel === null) {
    return `${action.name}: secrets target ${action.target} not found`;
  }
  const destination = await inspectDestination(consumer, rel, action.key);
  if (!destination.ok) {
    return `${action.name}: ${destination.problem}`;
  }
  if (destination.state !== 'scalar') {
    return `${action.name}: secret ${action.target}:${action.key} disappeared before renewal`;
  }
  const replacement = await createToken(accountId, bootstrapToken, {
    name: action.name,
    policies: action.policies,
    expiresOn: action.replacementExpiresOn,
    condition: action.condition,
  });
  if (!replacement.ok) {
    return `${action.name}: ${replacement.problem}`;
  }
  const { id: replacementId, value } = replacement.value;
  const written = writeValue(consumer, rel, action.key, value);
  const verified = verifyStoredValue(consumer, rel, action.key, value);
  if (verified.ok && !verified.matches) {
    const problem = written.ok
      ? `${action.name}: ${rel} at ${action.key} now holds a value matching neither the old nor the replacement token; repair the stored value manually`
      : `${action.name}: ${written.problem}`;
    return cleanupReplacement(account, replacementId, action.tokenId, problem);
  }
  if (!verified.ok) {
    return `${action.name}: ${written.ok ? verified.problem : `${written.problem}; ${verified.problem}`}; account ${accountId} replacement ${replacementId} and old token ${action.tokenId} remain active because the stored value is unverifiable`;
  }
  const deleted = await deleteToken(accountId, bootstrapToken, action.tokenId);
  return deleted.ok
    ? null
    : `${action.name}: replacement ${replacementId} is stored, but old token ${action.tokenId} could not be revoked: ${deleted.problem}`;
};

const fail = (message: string): false => {
  console.error(`standards creds: ${message}`);
  return false;
};

export const runCredsPlan = async (
  consumer: string,
  apply: boolean,
): Promise<boolean> => {
  const store = await readBrokerStore(resolveBrokerPath());
  if (store.cloudflare.length === 0) {
    console.log(
      'standards creds: no Cloudflare accounts configured; nothing to reconcile (`standards creds login cloudflare`)',
    );
    return true;
  }
  const repo = resolveGithubRepo(consumer);
  if (repo === null) {
    return fail('cannot resolve the GitHub repository from the origin remote');
  }
  const state = await gatherRepoState(consumer, store);
  for (const problem of state.problems) {
    console.error(`standards creds: ${problem}`);
  }
  if (state.problems.length > 0) {
    return fail(
      'reconciliation aborted because repository or provider state could not be read safely',
    );
  }
  const plan = computeCredsPlan({
    repo,
    keysByTarget: state.keysByTarget,
    tokens: state.tokens,
    now: new Date(),
  });
  for (const action of plan.actions) {
    console.log(
      `  ${apply ? '' : 'would '}${action.kind} ${action.name} (${action.reason})`,
    );
  }
  for (const finding of plan.findings) {
    console.error(`standards creds: ${finding}`);
  }
  console.log(
    `standards creds: ${plan.actions.length} action(s), ${plan.findings.length} finding(s), ${plan.healthy} brokered token(s) healthy`,
  );
  if (plan.findings.length > 0) {
    return fail('reconciliation aborted until every finding is resolved');
  }
  if (!apply || plan.actions.length === 0) {
    return true;
  }
  const failures = (
    await Promise.all(
      plan.actions.map((action) => applyAction(consumer, store, action)),
    )
  ).filter((failure): failure is string => failure !== null);
  for (const failure of failures) {
    console.error(`standards creds: ${failure}`);
  }
  return failures.length === 0;
};
