// Brokered S3 pair references let a plain configuration layer point a
// workspace env key at a credential pair the creds broker owns in another
// SOPS target. The secret value then has exactly one home — the broker's
// ledger — so rotation stays the broker's job and no copy can go stale.
// A reference is configuration, never a secret, so the SOPS-encrypted
// secrets layer must not declare one.

import { parseSopsKeyPath } from './creds-sops-structure';
import { isRecord } from './github-settings-parse';

export const BROKERED_S3_PARTS = [
  'access_key_id',
  'secret_access_key',
] as const;

export type BrokeredS3Part = (typeof BROKERED_S3_PARTS)[number];

export type BrokeredS3Reference = {
  readonly brokeredS3: string;
  readonly key: string;
  readonly part: BrokeredS3Part;
};

const REFERENCE_PROPERTIES = ['brokeredS3', 'key', 'part'] as const;

export const isBrokeredS3ReferenceShape = (
  value: unknown,
): value is Record<string, unknown> => isRecord(value) && 'brokeredS3' in value;

export type BrokeredS3ParseResult =
  | { readonly ok: true; readonly reference: BrokeredS3Reference }
  | { readonly ok: false; readonly problems: ReadonlyArray<string> };

const isBrokeredS3Part = (value: unknown): value is BrokeredS3Part =>
  BROKERED_S3_PARTS.includes(value as BrokeredS3Part);

// Target-name validity and existence are owned by `resolveTargetRel` at
// resolution time; parsing only checks the reference's own shape.
export const parseBrokeredS3Reference = (
  label: string,
  raw: Record<string, unknown>,
): BrokeredS3ParseResult => {
  const problems: Array<string> = [];
  for (const property of Object.keys(raw)) {
    if (!REFERENCE_PROPERTIES.includes(property as 'brokeredS3')) {
      problems.push(
        `${label} brokered S3 pair reference has unknown property ${JSON.stringify(property)}; allowed properties are brokeredS3, key, and part`,
      );
    }
  }
  const { brokeredS3: target, key, part } = raw;
  if (typeof target !== 'string' || target.length === 0) {
    problems.push(
      `${label} brokered S3 pair reference needs a non-empty "brokeredS3" secrets target name`,
    );
  }
  if (typeof key !== 'string' || parseSopsKeyPath(key) === null) {
    problems.push(
      `${label} brokered S3 pair reference needs a "key" naming the pair's dotted SOPS key`,
    );
  }
  if (!isBrokeredS3Part(part)) {
    problems.push(
      `${label} brokered S3 pair reference needs a "part" of either "access_key_id" or "secret_access_key"`,
    );
  }
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    reference: {
      brokeredS3: target as string,
      key: key as string,
      part: part as BrokeredS3Part,
    },
  };
};
