// Renewal execution for `standards creds apply`: create the replacement
// first, durably write and verify the SOPS destination, and only then retire
// the old token. Retiring renames it superseded and keeps its expiry rather
// than deleting it, because a running host keeps using it until the new SOPS
// value deploys. An unverifiable destination keeps both tokens; a verified
// mismatch deletes the replacement and preserves the old token.

import {
  createAccountToken,
  deleteAccountToken,
  updateAccountToken,
} from './creds-cloudflare';
import { supersededNameOf } from './creds-naming';
import type { PlannedAction } from './creds-plan-types';
import { destinationWrites, s3AccessKeyPath, s3PairPaths } from './creds-r2';
import { inspectSopsScalarDestination, setSopsValues } from './creds-sops';
import { verifySopsStoredValue } from './creds-sops-value';
import { type CloudflareBrokerAccount, resolveBrokerPath } from './creds-store';
import { withBrokerLock } from './creds-store-lock';
import { resolveTargetRelResult } from './creds-target';
import type { BrokeredRefreshEvidence } from './dev-env-brokered-refresh';

type RenewAction = Extract<PlannedAction, { readonly kind: 'renew' }>;

export type RenewPlannedTokenResult = {
  readonly failure: string | null;
  readonly refreshEvidence: BrokeredRefreshEvidence | null;
};

const renewalResult = (
  failure: string | null,
  evidence: BrokeredRefreshEvidence | null = null,
): RenewPlannedTokenResult => ({ failure, refreshEvidence: evidence });

const refreshEvidence = (
  action: RenewAction,
  safety: BrokeredRefreshEvidence['safety'],
): BrokeredRefreshEvidence | null =>
  action.format === 's3'
    ? { target: action.target, key: action.key, safety }
    : null;

const cleanupReplacement = async (
  account: CloudflareBrokerAccount,
  replacementId: string,
  oldId: string,
  context: string,
): Promise<string> => {
  const { accountId, token } = account;
  const cleanup = await deleteAccountToken(accountId, token, replacementId);
  return cleanup.ok
    ? `${context}; deleted replacement ${replacementId} and preserved old token ${oldId}`
    : `${context}; cleanup of replacement ${replacementId} also failed: ${cleanup.problem}; old token ${oldId} was not revoked`;
};

const inspectRenewDestinations = async (
  consumer: string,
  rel: string,
  action: RenewAction,
): Promise<string | null> => {
  const paths = action.format === 's3' ? s3PairPaths(action.key) : [action.key];
  const inspected = await Promise.all(
    paths.map((path) => inspectSopsScalarDestination(consumer, rel, path)),
  );
  const blocked = inspected.find((result) => !result.ok);
  if (blocked !== undefined && !blocked.ok) {
    return `${action.name}: ${blocked.problem}`;
  }
  return inspected.some((result) => result.ok && result.state !== 'scalar')
    ? `${action.name}: secret ${action.target}:${action.key} disappeared before renewal`
    : null;
};

// An expired old token grants nothing, so nothing waits on it.
const retireOldToken = (
  account: CloudflareBrokerAccount,
  action: RenewAction,
): ReturnType<typeof deleteAccountToken> =>
  action.supersededExpiresOn === null
    ? deleteAccountToken(account.accountId, account.token, action.tokenId)
    : updateAccountToken(account.accountId, account.token, action.tokenId, {
        name: supersededNameOf(action.name),
        policies: action.policies,
        expiresOn: action.supersededExpiresOn,
        condition: action.condition,
      });

const renewWhileLocked = async (
  consumer: string,
  account: CloudflareBrokerAccount,
  action: RenewAction,
): Promise<RenewPlannedTokenResult> => {
  const { accountId, token: bootstrapToken } = account;
  const resolved = resolveTargetRelResult(consumer, action.target);
  if (!resolved.ok) {
    return renewalResult(`${action.name}: ${resolved.problem}`);
  }
  const { rel } = resolved;
  const destinationProblem = await inspectRenewDestinations(
    consumer,
    rel,
    action,
  );
  if (destinationProblem !== null) {
    return renewalResult(destinationProblem, refreshEvidence(action, 'unsafe'));
  }
  if (action.format === 's3') {
    const accessKey = verifySopsStoredValue(
      consumer,
      rel,
      s3AccessKeyPath(action.key),
      action.tokenId,
    );
    if (!(accessKey.ok && accessKey.matches)) {
      return renewalResult(
        `${action.name}: could not prove the stored S3 access key belongs to the managed token; renewal stopped before mutation`,
        refreshEvidence(action, 'unsafe'),
      );
    }
  }
  const replacement = await createAccountToken(accountId, bootstrapToken, {
    name: action.name,
    policies: action.policies,
    expiresOn: action.replacementExpiresOn,
    condition: action.condition,
  });
  if (!replacement.ok) {
    return renewalResult(`${action.name}: ${replacement.problem}`);
  }
  const { id: replacementId, value } = replacement.value;
  const writes = destinationWrites(
    action.format,
    action.key,
    replacementId,
    value,
  );
  const written = setSopsValues(consumer, rel, writes);
  const verified = writes.map((write) => ({
    path: write.path,
    result: verifySopsStoredValue(consumer, rel, write.path, write.value),
  }));
  const unverifiable = verified.flatMap(({ result }) =>
    result.ok ? [] : [result.problem],
  );
  if (unverifiable.length > 0) {
    const detail = unverifiable.join('; ');
    return renewalResult(
      `${action.name}: ${written.ok ? detail : `${written.problem}; ${detail}`}; account ${accountId} replacement ${replacementId} remains active and old token ${action.tokenId} was not revoked because the stored value is unverifiable`,
      refreshEvidence(action, 'unsafe'),
    );
  }
  const mismatched = verified.flatMap(({ path, result }) =>
    result.ok && !result.matches ? [path] : [],
  );
  if (mismatched.length > 0) {
    const problem = written.ok
      ? `${action.name}: ${rel} at ${mismatched.join(', ')} now holds a value matching neither the old nor the replacement token; repair the stored value manually`
      : `${action.name}: ${written.problem}`;
    return renewalResult(
      await cleanupReplacement(account, replacementId, action.tokenId, problem),
      refreshEvidence(action, 'unsafe'),
    );
  }
  const retired = await retireOldToken(account, action);
  return renewalResult(
    retired.ok
      ? null
      : `${action.name}: replacement ${replacementId} is stored, but old token ${action.tokenId} could not be retired: ${retired.problem}; once the replacement has deployed, retire it with \`standards creds revoke --account ${accountId} --token-id ${action.tokenId}\``,
    refreshEvidence(action, 'verified'),
  );
};

// Duplicate retirement uses this same lock. Hold it before minting until the
// replacement is durably verified and the old token's retirement has finished.
export const renewPlannedToken = (
  consumer: string,
  account: CloudflareBrokerAccount,
  action: RenewAction,
): Promise<RenewPlannedTokenResult> =>
  withBrokerLock(resolveBrokerPath(), () =>
    renewWhileLocked(consumer, account, action),
  );
