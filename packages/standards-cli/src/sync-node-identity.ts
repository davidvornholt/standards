export type NodeIdentity = {
  readonly dev: bigint;
  readonly ino: bigint;
};

export const MAX_FILESYSTEM_IDENTITY = 18_446_744_073_709_551_615n;

export const assertFilesystemIdentityComponent = (
  value: bigint,
  label: string,
): bigint => {
  if (value < 0n || value > MAX_FILESYSTEM_IDENTITY) {
    throw new Error(`${label} is outside the supported uint64 range`);
  }
  return value;
};

export type StoredNodeIdentity = {
  readonly dev: string;
  readonly ino: string;
};

const DECIMAL_IDENTITY = /^(?:0|[1-9]\d*)$/u;

export const storedNodeIdentity = (
  identity: NodeIdentity,
): StoredNodeIdentity => ({
  dev: identity.dev.toString(),
  ino: identity.ino.toString(),
});

const identityComponent = (
  value: unknown,
  label: string,
  allowLegacyNumber: boolean,
): bigint => {
  if (typeof value === 'string' && DECIMAL_IDENTITY.test(value)) {
    return assertFilesystemIdentityComponent(BigInt(value), label);
  }
  if (
    allowLegacyNumber &&
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return assertFilesystemIdentityComponent(BigInt(value), label);
  }
  throw new Error(`${label} must be a canonical decimal filesystem identity`);
};

export const parseStoredNodeIdentity = (
  value: unknown,
  label: string,
  options: { readonly allowLegacyNumber?: boolean } = {},
): NodeIdentity => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a filesystem identity object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'dev,ino') {
    throw new Error(`${label} must contain only dev and ino`);
  }
  return {
    dev: identityComponent(
      record.dev,
      `${label}.dev`,
      options.allowLegacyNumber === true,
    ),
    ino: identityComponent(
      record.ino,
      `${label}.ino`,
      options.allowLegacyNumber === true,
    ),
  };
};
