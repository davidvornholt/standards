// Pure reconciliation between a repository's SOPS key structure and the
// Cloudflare tokens the broker minted for it (matched by the deterministic
// naming scheme). A brokered token whose secret key vanished from SOPS is
// revoked; one nearing expiry is replaced while copying its live policy and
// lifetime. Secret keys without a brokered token are simply unmanaged — most
// secrets are — and are never touched. Execution lives in creds-plan-run.ts.

import type { CloudflareToken, TokenPolicy } from './creds-cloudflare-api';
import type { TokenCondition } from './creds-cloudflare-condition';
import { parseTokenName } from './creds-naming';

const DEFAULT_RENEW_WITHIN_DAYS = 30;
const DAY_MS = 86_400_000;

export type AccountToken = {
  readonly accountId: string;
  readonly token: CloudflareToken;
};

export type PlannedAction =
  | {
      readonly kind: 'revoke';
      readonly accountId: string;
      readonly tokenId: string;
      readonly name: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'renew';
      readonly accountId: string;
      readonly tokenId: string;
      readonly name: string;
      readonly target: string;
      readonly key: string;
      readonly policies: ReadonlyArray<TokenPolicy>;
      readonly condition: TokenCondition | null;
      readonly replacementExpiresOn: string;
      readonly reason: string;
    };

export type CredsPlan = {
  readonly actions: ReadonlyArray<PlannedAction>;
  readonly findings: ReadonlyArray<string>;
  readonly healthy: number;
};

type ManagedToken = AccountToken & {
  readonly ref: { readonly target: string; readonly key: string };
};

type Disposition =
  | { readonly kind: 'action'; readonly action: PlannedAction }
  | { readonly kind: 'finding'; readonly finding: string }
  | { readonly kind: 'healthy' };

const dispositionOf = (
  entry: ManagedToken,
  input: {
    readonly keysByTarget: ReadonlyMap<string, ReadonlySet<string>>;
    readonly now: Date;
  },
  renewWithin: number,
): Disposition => {
  const { accountId, token, ref } = entry;
  const base = { accountId, tokenId: token.id, name: token.name };
  if (token.status !== 'active') {
    return {
      kind: 'finding',
      finding: `${token.name} (${accountId}/${token.id}) has status ${token.status}; it is not healthy and will not be mutated automatically`,
    };
  }
  if (!input.keysByTarget.get(ref.target)?.has(ref.key)) {
    return {
      kind: 'action',
      action: {
        ...base,
        kind: 'revoke',
        reason: `secret ${ref.target}:${ref.key} no longer exists`,
      },
    };
  }
  if (!token.condition.supported) {
    return {
      kind: 'finding',
      finding: `${token.name} has an unsupported condition shape; it will not be mutated automatically`,
    };
  }
  if (token.expiresOn === null) {
    return { kind: 'healthy' };
  }
  const expiry = Date.parse(token.expiresOn);
  if (!Number.isFinite(expiry)) {
    return {
      kind: 'finding',
      finding: `${token.name} has an invalid expires_on value`,
    };
  }
  if (expiry - input.now.getTime() > renewWithin) {
    return { kind: 'healthy' };
  }
  const issued =
    token.issuedOn === null ? Number.NaN : Date.parse(token.issuedOn);
  if (
    !Number.isFinite(issued) ||
    issued >= expiry ||
    token.policies === null ||
    token.policies.length === 0
  ) {
    return {
      kind: 'finding',
      finding: `${token.name} cannot be renewed safely because its issued_on, expires_on, or policies are incomplete`,
    };
  }
  return {
    kind: 'action',
    action: {
      ...base,
      kind: 'renew',
      target: ref.target,
      key: ref.key,
      policies: token.policies,
      condition: token.condition.value,
      replacementExpiresOn: new Date(
        input.now.getTime() + expiry - issued,
      ).toISOString(),
      reason: `expires ${token.expiresOn}`,
    },
  };
};

const dispositionForGroup = (
  group: ReadonlyArray<ManagedToken>,
  input: {
    readonly keysByTarget: ReadonlyMap<string, ReadonlySet<string>>;
    readonly now: Date;
  },
  renewWithin: number,
): Disposition => {
  if (group.length > 1) {
    const [first] = group;
    return {
      kind: 'finding',
      finding: `ambiguous Cloudflare tokens target ${first?.ref.target}:${first?.ref.key} across ${group.map((candidate) => `${candidate.accountId}/${candidate.token.id}`).join(', ')}; revoke duplicates manually before plan/apply`,
    };
  }
  const [entry] = group;
  return entry === undefined
    ? { kind: 'healthy' }
    : dispositionOf(entry, input, renewWithin);
};

export const computeCredsPlan = (input: {
  readonly repo: string;
  readonly keysByTarget: ReadonlyMap<string, ReadonlySet<string>>;
  readonly tokens: ReadonlyArray<AccountToken>;
  readonly now: Date;
  readonly renewWithinDays?: number;
}): CredsPlan => {
  const renewWithin =
    (input.renewWithinDays ?? DEFAULT_RENEW_WITHIN_DAYS) * DAY_MS;
  const actions: Array<PlannedAction> = [];
  const findings: Array<string> = [];
  let healthy = 0;
  const managed = input.tokens.flatMap((entry) => {
    const ref = parseTokenName(entry.token.name, input.repo);
    return ref === null ? [] : [{ ...entry, ref }];
  });
  const byDestination = Map.groupBy(
    managed,
    ({ ref }) => `${ref.target}\0${ref.key}`,
  );
  const dispositions = [...byDestination.values()].map((group) =>
    dispositionForGroup(group, input, renewWithin),
  );
  for (const disposition of dispositions) {
    if (disposition.kind === 'action') {
      actions.push(disposition.action);
    } else if (disposition.kind === 'finding') {
      findings.push(disposition.finding);
    } else {
      healthy += 1;
    }
  }
  return { actions, findings, healthy };
};
