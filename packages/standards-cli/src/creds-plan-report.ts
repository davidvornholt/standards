// The operator-facing rendering of a computed plan. Every block is labelled and
// printed only when it has entries, because the three lists say different
// things: what reconciliation will do, what it will never touch, and what no
// repository reconciles at all. The summary counts them apart for the same
// reason.

import type {
  BrokeredElsewhereToken,
  CredsPlan,
  PlannedAction,
  UnmanagedToken,
} from './creds-plan-types';

// Each listed token is offered with the exact command that retires it rather
// than with identifiers to reassemble: `plan` already holds the account, and
// `revoke` demands it whenever the broker holds more than one.
const revokeCommand = (token: UnmanagedToken, extra: string): string =>
  `\`standards creds revoke --account ${token.accountId} --token-id ${token.tokenId}${extra}\``;

const reportActions = (
  actions: ReadonlyArray<PlannedAction>,
  apply: boolean,
): void => {
  if (actions.length === 0) {
    return;
  }
  console.log(`standards creds: ${apply ? '' : 'planned '}actions`);
  for (const action of actions) {
    console.log(
      `  ${apply ? '' : 'would '}${action.kind} ${action.name} (${action.reason})`,
    );
  }
};

const reportUnmanaged = (tokens: ReadonlyArray<UnmanagedToken>): void => {
  if (tokens.length === 0) {
    return;
  }
  console.log(
    'standards creds: unmanaged tokens — the broker mints nothing of this shape, and plan and apply never mutate them',
  );
  for (const token of tokens) {
    console.log(
      `  ${token.name} (${token.status}) — retire it with ${revokeCommand(token, '')}`,
    );
  }
};

const reportBrokeredElsewhere = (
  tokens: ReadonlyArray<BrokeredElsewhereToken>,
): void => {
  if (tokens.length === 0) {
    return;
  }
  console.log(
    'standards creds: tokens brokered to another repository — reconciled in that repository, never mutated here',
  );
  for (const token of tokens) {
    console.log(
      `  ${token.name} (${token.status}) — brokered to ${token.repo}; if ${token.repo} was renamed, transferred, or deleted then nothing reconciles this token any more, and only then: ${revokeCommand(token, ' --force')}`,
    );
  }
};

export const reportCredsPlan = (plan: CredsPlan, apply: boolean): void => {
  reportActions(plan.actions, apply);
  reportUnmanaged(plan.unmanaged);
  reportBrokeredElsewhere(plan.brokeredElsewhere);
  for (const finding of plan.findings) {
    console.error(`standards creds: ${finding}`);
  }
  console.log(
    `standards creds: ${plan.actions.length} action(s), ${plan.findings.length} finding(s), ${plan.healthy} brokered token(s) healthy, ${plan.unmanaged.length} unmanaged token(s), ${plan.brokeredElsewhere.length} token(s) brokered to another repository`,
  );
};
