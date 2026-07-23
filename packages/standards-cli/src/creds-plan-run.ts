import { listSecretsTargets } from './creds-dest';
import { identifyCloudflareBootstrapAuthority } from './creds-login-cloudflare';
import {
  type AccountToken,
  computeCredsPlan,
  type PlannedAction,
} from './creds-plan';
import { renewPlannedToken } from './creds-plan-renew';
import { revokePlannedToken } from './creds-plan-revoke';
import { readEncryptedKeys } from './creds-sops';
import {
  type BrokerStore,
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

const applyAction = (
  consumer: string,
  store: BrokerStore,
  action: PlannedAction,
): Promise<string | null> => {
  const account = store.cloudflare.find(
    (entry) => entry.accountId === action.accountId,
  );
  if (account === undefined) {
    return Promise.resolve(
      `${action.name}: account ${action.accountId} is not in the broker store`,
    );
  }
  return action.kind === 'revoke'
    ? revokePlannedToken(account, action)
    : renewPlannedToken(consumer, account, action);
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
