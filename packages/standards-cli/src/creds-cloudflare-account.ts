import { isCloudflareId } from './creds-cloudflare-id';

export const isCloudflareAccountId = (value: unknown): value is string =>
  typeof value === 'string' && isCloudflareId(value);
