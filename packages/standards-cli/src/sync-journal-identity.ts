const DECIMAL = /^(?:0|[1-9]\d*)$/u;

export const journalIdentityString = (
  value: unknown,
  label: string,
  allowLegacyNumber: boolean,
): string => {
  if (typeof value === 'string' && DECIMAL.test(value)) {
    return value;
  }
  if (
    allowLegacyNumber &&
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return String(value);
  }
  throw new Error(`${label} must be a canonical decimal filesystem identity`);
};

export const nullableJournalIdentityString = (
  value: unknown,
  label: string,
  allowLegacyNumber: boolean,
): string | null =>
  value === null
    ? null
    : journalIdentityString(value, label, allowLegacyNumber);
