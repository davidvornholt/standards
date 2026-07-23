// Cloudflare rejects fractional seconds in expires_on before creating the
// token; it requires whole-second RFC3339 like "2005-12-30T01:02:03Z".

const FRACTIONAL_SECONDS = /\.\d{3}Z$/u;

export const cloudflareExpiresOn = (epochMs: number): string =>
  new Date(epochMs).toISOString().replace(FRACTIONAL_SECONDS, 'Z');
