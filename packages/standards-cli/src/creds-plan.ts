// Pure reconciliation between a repository's SOPS key structure and the
// Cloudflare tokens the broker minted for it (matched by the deterministic
// naming scheme). A brokered token whose secret key vanished from SOPS is
// revoked; one nearing expiry is replaced while copying its live policy and
// lifetime. Secret keys without a brokered token are simply unmanaged — most
// secrets are — and are never touched. Execution lives in creds-plan-run.ts.

import { cloudflareExpiresOn } from './creds-cloudflare-expiry';
import { parseTokenName } from './creds-naming';
import { groupByIntersectingFootprint } from './creds-plan-groups';
import type {
  AccountToken,
  CredsPlan,
  PlannedAction,
} from './creds-plan-types';
import { destinationFormatOf, inferredDestinationFootprint } from './creds-r2';

const DEFAULT_RENEW_WITHIN_DAYS = 30;
const DAY_MS = 86_400_000;

type ManagedToken = AccountToken & {
  readonly ref: { readonly target: string; readonly key: string };
  readonly footprint: ReadonlyArray<string>;
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
  const format = destinationFormatOf(
    input.keysByTarget.get(ref.target),
    ref.key,
  );
  if (format === 'absent') {
    return {
      kind: 'action',
      action: {
        ...base,
        kind: 'revoke',
        reason: `secret ${ref.target}:${ref.key} no longer exists`,
      },
    };
  }
  if (format === 'partial') {
    return {
      kind: 'finding',
      finding: `${token.name} maps to an incomplete S3 credential pair at ${ref.target}:${ref.key} (expected both access_key_id and secret_access_key); it will not be mutated automatically`,
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
      format,
      policies: token.policies,
      condition: token.condition.value,
      replacementExpiresOn: cloudflareExpiresOn(
        input.now.getTime() + expiry - issued,
      ),
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
      finding: `ambiguous Cloudflare tokens have destination footprints intersecting in ${first?.ref.target}: ${group.map((candidate) => `${candidate.ref.key} (${candidate.accountId}/${candidate.token.id})`).join(', ')}; revoke duplicates manually before plan/apply`,
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
    return ref === null
      ? []
      : [
          {
            ...entry,
            ref,
            footprint: inferredDestinationFootprint(
              input.keysByTarget.get(ref.target),
              ref.key,
            ),
          },
        ];
  });
  const dispositions = groupByIntersectingFootprint(managed).map((group) =>
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
