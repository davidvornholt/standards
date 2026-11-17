// A year: long enough that renewal is a yearly chore rather than a quarterly
// outage risk, short enough that a leaked or forgotten token still dies on its
// own. Renewal never shortens a token below it, so the 90-day tokens minted
// before standards#545 get a year at their next renewal.
export const BROKERED_TOKEN_LIFETIME_DAYS = 365;

// `creds apply` renews a brokered token this close to its expiry, and
// `creds watch` reports it from the same moment, so the renewal an expiry
// issue asks for is always one apply performs.
export const RENEW_WITHIN_DAYS = 30;

export const DAY_MS = 86_400_000;

// Cloudflare rejects fractional seconds in expires_on before creating the
// token; it requires whole-second RFC3339 like "2005-12-30T01:02:03Z".

const FRACTIONAL_SECONDS = /\.\d{3}Z$/u;

export const cloudflareExpiresOn = (epochMs: number): string =>
  new Date(epochMs).toISOString().replace(FRACTIONAL_SECONDS, 'Z');

// Renewal leaves the token it replaced working this long, never longer than it
// had left, because a running host keeps using it until the new SOPS value
// deploys and `apply` can't see when that happens (standards#565). A week
// covers a pull request that waits a few days for review; the old token had up
// to RENEW_WITHIN_DAYS left anyway, so this only shortens its life.
export const SUPERSEDED_GRACE_DAYS = 7;
