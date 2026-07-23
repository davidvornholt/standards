const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/u;

export const isCloudflareAccountId = (value: unknown): value is string =>
  typeof value === 'string' && ACCOUNT_ID_PATTERN.test(value);
