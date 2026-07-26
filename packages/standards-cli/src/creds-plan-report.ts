// The operator-facing rendering of a computed plan. Every block is labelled and
// printed only when it has entries, because the three lists say different
// things: what reconciliation will do, what it will never touch, and what no
// repository reconciles at all. The summary counts them apart for the same
// reason.

import { BROKER_IDENTITY_NAME } from './creds-naming';
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

// One unmanaged shape has no revoke command to offer: the reserved bootstrap
// name. This machine's own bootstrap is excluded from the listing by verified
// ID, so a row under that name is another machine's or a superseded one, and
// `revoke` refuses it by name — printing a command that always fails would
// send the operator down a dead end. The remedy is the dashboard, which is
// also the only place the machine it belongs to can be confirmed.
const unmanagedRemedy = (token: UnmanagedToken): string =>
  token.name === BROKER_IDENTITY_NAME
    ? "the reserved name for a machine's broker bootstrap credential, which `revoke` refuses; retire it in the Cloudflare dashboard, where you can confirm which machine it belongs to"
    : `retire it with ${revokeCommand(token, '')}`;

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
    'standards creds: unmanaged tokens — reconciliation mints nothing of this shape, and plan and apply never mutate them',
  );
  for (const token of tokens) {
    console.log(
      `  ${token.name} (${token.status}) — ${unmanagedRemedy(token)}`,
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
    'standards creds: tokens brokered to another repository — never mutated here, and reconciled there only if a checkout still mints that exact name',
  );
  for (const token of tokens) {
    console.log(
      `  ${token.name} (${token.status}) — brokered to ${token.repo}; if no checkout mints this name any more — ${token.repo} renamed, transferred, or deleted — then nothing reconciles the token, and only then: ${revokeCommand(token, ' --force')}`,
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
