// Renewal execution for `standards creds apply`: create the replacement
// first, durably write and verify the SOPS destination, and only then revoke
// the old token. An unverifiable destination keeps both tokens; a verified
// mismatch deletes the replacement and preserves the old token.

import { createAccountToken, deleteAccountToken } from './creds-cloudflare';
import { resolveTargetRel } from './creds-dest';
import type { PlannedAction } from './creds-plan';
import { destinationWrites, s3PairPaths } from './creds-r2';
import {
  inspectSopsScalarDestination,
  setSopsValues,
  verifySopsStoredValue,
} from './creds-sops';
import type { CloudflareBrokerAccount } from './creds-store';

type RenewAction = Extract<PlannedAction, { readonly kind: 'renew' }>;

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
    : `${context}; cleanup of replacement ${replacementId} also failed: ${cleanup.problem}; old token ${oldId} remains active`;
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

export const renewPlannedToken = async (
  consumer: string,
  account: CloudflareBrokerAccount,
  action: RenewAction,
): Promise<string | null> => {
  const { accountId, token: bootstrapToken } = account;
  const rel = resolveTargetRel(consumer, action.target);
  if (rel === null) {
    return `${action.name}: secrets target ${action.target} not found`;
  }
  const destinationProblem = await inspectRenewDestinations(
    consumer,
    rel,
    action,
  );
  if (destinationProblem !== null) {
    return destinationProblem;
  }
  const replacement = await createAccountToken(accountId, bootstrapToken, {
    name: action.name,
    policies: action.policies,
    expiresOn: action.replacementExpiresOn,
    condition: action.condition,
  });
  if (!replacement.ok) {
    return `${action.name}: ${replacement.problem}`;
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
    return `${action.name}: ${written.ok ? detail : `${written.problem}; ${detail}`}; account ${accountId} replacement ${replacementId} and old token ${action.tokenId} remain active because the stored value is unverifiable`;
  }
  const mismatched = verified.flatMap(({ path, result }) =>
    result.ok && !result.matches ? [path] : [],
  );
  if (mismatched.length > 0) {
    const problem = written.ok
      ? `${action.name}: ${rel} at ${mismatched.join(', ')} now holds a value matching neither the old nor the replacement token; repair the stored value manually`
      : `${action.name}: ${written.problem}`;
    return cleanupReplacement(account, replacementId, action.tokenId, problem);
  }
  const deleted = await deleteAccountToken(
    accountId,
    bootstrapToken,
    action.tokenId,
  );
  return deleted.ok
    ? null
    : `${action.name}: replacement ${replacementId} is stored, but old token ${action.tokenId} could not be revoked: ${deleted.problem}`;
};
