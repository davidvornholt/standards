// Cloudflare identifies accounts, zones, and API tokens by the same
// 32-character lowercase hexadecimal shape, and this module owns that shape for
// all three. Checking it before a request turns a typo into a precise message
// instead of a provider 404, which reads the same as a resource that exists but
// is out of reach.

const CLOUDFLARE_ID = /^[0-9a-f]{32}$/u;

export const isCloudflareId = (value: string): boolean =>
  CLOUDFLARE_ID.test(value);
