import { deleteAccountToken } from './creds-cloudflare';
import type { PlannedAction } from './creds-plan-types';
import type { CloudflareBrokerAccount } from './creds-store';

export const revokePlannedToken = async (
  account: CloudflareBrokerAccount,
  action: Extract<PlannedAction, { readonly kind: 'revoke' }>,
): Promise<string | null> => {
  const deleted = await deleteAccountToken(
    account.accountId,
    account.token,
    action.tokenId,
  );
  return deleted.ok ? null : `${action.name}: ${deleted.problem}`;
};
