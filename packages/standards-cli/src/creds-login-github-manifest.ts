// Pure manifest-flow pieces for the GitHub broker login: the App manifest,
// the auto-submitting form, the one-time state token, and the conversion
// exchange. The localhost listener and the login orchestration live in
// creds-login-github.ts.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { GithubBrokerApp } from './creds-store';
import { apiError, HTTP_CREATED, request } from './github-api';
import { isRecord } from './github-settings-parse';

export const MANIFEST_STATE_BYTES = 32;

// Root-credential ceiling: everything the broker may ever delegate. Actual
// grants are narrowed per installation token at mint time.
const DEFAULT_PERMISSIONS = Object.fromEntries(
  'administration actions contents issues pull_requests secrets workflows'
    .split(' ')
    .map((permission) => [permission, 'write']),
);

export const buildAppManifest = (
  name: string,
  redirectUrl: string,
): Readonly<Record<string, unknown>> => ({
  name,
  url: 'https://github.com/davidvornholt/standards',
  hook_attributes: { url: 'https://example.invalid/unused', active: false },
  redirect_url: redirectUrl,
  public: false,
  default_permissions: DEFAULT_PERMISSIONS,
  default_events: [],
});

const escapeAttribute = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

export const createManifestState = () => {
  const expected = randomBytes(MANIFEST_STATE_BYTES);
  let available = true;
  return {
    value: expected.toString('hex'),
    accept: (candidate: string | null) => {
      const received =
        candidate === null ? Buffer.alloc(0) : Buffer.from(candidate, 'hex');
      const matches =
        available &&
        received.length === expected.length &&
        timingSafeEqual(received, expected);
      available = matches ? false : available;
      return matches;
    },
  };
};

export const manifestFormHtml = (
  action: string,
  manifest: string,
  state: string,
): string =>
  `<!doctype html><html><body><form id="m" action="${escapeAttribute(`${action}?state=${encodeURIComponent(state)}`)}" method="post"><input type="hidden" name="manifest" value="${escapeAttribute(manifest)}"><noscript><button type="submit">Create GitHub App</button></noscript></form><script>document.getElementById("m").submit()</script></body></html>`;

export const parseConversion = (body: unknown): GithubBrokerApp | null =>
  isRecord(body) &&
  typeof body.id === 'number' &&
  typeof body.slug === 'string' &&
  typeof body.html_url === 'string' &&
  typeof body.client_id === 'string' &&
  typeof body.pem === 'string'
    ? {
        appId: body.id,
        slug: body.slug,
        htmlUrl: body.html_url,
        clientId: body.client_id,
        privateKey: body.pem,
      }
    : null;

export type ManifestConversion =
  | { readonly ok: true; readonly app: GithubBrokerApp }
  | { readonly ok: false; readonly problem: string };

// POST /app-manifests/{code}/conversions — note the plural resource name:
// the singular path hits no route and GitHub answers with the same bare 404
// an expired code would get. The wire-contract test pins this request line.
export const convertManifestCode = async (
  code: string,
): Promise<ManifestConversion> => {
  const conversion = await request(
    null,
    'POST',
    `/app-manifests/${code}/conversions`,
  );
  if (conversion.status !== HTTP_CREATED) {
    return { ok: false, problem: apiError('manifest conversion', conversion) };
  }
  const app = parseConversion(conversion.body);
  return app === null
    ? { ok: false, problem: 'unexpected manifest conversion response shape' }
    : { ok: true, app };
};
