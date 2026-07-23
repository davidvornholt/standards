// Orchestration for `standards creds plan` and `apply`: gather the SOPS key
// structure and brokered token lists, compute the plan, and — for apply —
// revoke orphans and roll expiring tokens, writing rolled values back into
// their SOPS targets.

import {
  deleteAccountToken,
  listAccountTokens,
  rollAccountToken,
} from './creds-cloudflare';
import {
  type AccountToken,
  computeCredsPlan,
  type PlannedAction,
} from './creds-plan';
import {
  listSecretsTargets,
  readEncryptedKeys,
  setSopsValue,
} from './creds-sops';
import {
  type BrokerStore,
  readBrokerStore,
  resolveBrokerPath,
} from './creds-store';
import { resolveGithubRepo } from './github-api';

const gatherRepoState = async (
  consumer: string,
  store: BrokerStore,
): Promise<{
  readonly keysByTarget: ReadonlyMap<string, ReadonlySet<string>>;
  readonly relByTarget: ReadonlyMap<string, string>;
  readonly tokens: ReadonlyArray<AccountToken>;
  readonly problems: ReadonlyArray<string>;
}> => {
  const keysByTarget = new Map<string, ReadonlySet<string>>();
  const relByTarget = new Map<string, string>();
  const targetKeys = await Promise.all(
    listSecretsTargets(consumer).map(async ({ target, rel }) => ({
      target,
      rel,
      keys: await readEncryptedKeys(consumer, rel),
    })),
  );
  for (const { target, rel, keys } of targetKeys) {
    if (keys !== null) {
      keysByTarget.set(target, new Set(keys));
      relByTarget.set(target, rel);
    }
  }
  const tokens: Array<AccountToken> = [];
  const problems: Array<string> = [];
  const listings = await Promise.all(
    store.cloudflare.map(async (account) => ({
      account,
      listed: await listAccountTokens(account.accountId, account.token),
    })),
  );
  for (const { account, listed } of listings) {
    if (listed.ok) {
      tokens.push(
        ...listed.value.map((token) => ({
          accountId: account.accountId,
          token,
        })),
      );
    } else {
      problems.push(`account ${account.accountId}: ${listed.problem}`);
    }
  }
  return { keysByTarget, relByTarget, tokens, problems };
};

const applyAction = async (
  consumer: string,
  store: BrokerStore,
  relByTarget: ReadonlyMap<string, string>,
  action: PlannedAction,
): Promise<string | null> => {
  const account = store.cloudflare.find(
    (entry) => entry.accountId === action.accountId,
  );
  if (account === undefined) {
    return `${action.name}: account ${action.accountId} is not in the broker store`;
  }
  if (action.kind === 'revoke') {
    const deleted = await deleteAccountToken(
      account.accountId,
      account.token,
      action.tokenId,
    );
    return deleted.ok ? null : `${action.name}: ${deleted.problem}`;
  }
  const rel = relByTarget.get(action.target);
  if (rel === undefined) {
    return `${action.name}: secrets target ${action.target} not found`;
  }
  const rolled = await rollAccountToken(
    account.accountId,
    account.token,
    action.tokenId,
  );
  if (!rolled.ok) {
    return `${action.name}: ${rolled.problem}`;
  }
  const written = setSopsValue(consumer, rel, action.key, rolled.value);
  return written.ok
    ? null
    : `${action.name}: rolled, but ${written.problem}; write the new value manually before the old one expires`;
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
    console.error(
      'standards creds: cannot resolve the GitHub repository from the origin remote',
    );
    return false;
  }
  const state = await gatherRepoState(consumer, store);
  for (const problem of state.problems) {
    console.error(`standards creds: ${problem}`);
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
  console.log(
    `standards creds: ${plan.actions.length} action(s), ${plan.healthy} brokered token(s) healthy`,
  );
  if (!apply || plan.actions.length === 0) {
    return state.problems.length === 0;
  }
  const failures = (
    await Promise.all(
      plan.actions.map((action) =>
        applyAction(consumer, store, state.relByTarget, action),
      ),
    )
  ).filter((failure): failure is string => failure !== null);
  for (const failure of failures) {
    console.error(`standards creds: ${failure}`);
  }
  return failures.length === 0 && state.problems.length === 0;
};
