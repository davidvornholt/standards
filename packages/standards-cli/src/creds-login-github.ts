// GitHub broker bootstrap via the App manifest flow: serve a localhost page
// that posts the pre-filled manifest to GitHub, the user clicks "Create
// GitHub App" once, GitHub redirects back with a temporary code, and the
// manifest conversion endpoint returns the App credentials — no secret is
// ever displayed or pasted. The App is the broker's GitHub root: workflows
// and creds commands mint short-lived, per-repo installation tokens from it.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openInBrowser } from './creds-browser';
import {
  type GithubBrokerApp,
  readBrokerStore,
  resolveBrokerPath,
  writeBrokerStore,
} from './creds-store';
import { HTTP_CREATED, HTTP_OK, request } from './github-api';
import { isRecord } from './github-settings-parse';

// Ten minutes: enough for the one browser click, short enough to fail loudly.
const LOGIN_TIMEOUT_MS = 600_000;

// Root-credential ceiling: everything the broker may ever delegate. Actual
// grants are narrowed per installation token at mint time.
const DEFAULT_PERMISSIONS = {
  administration: 'write',
  actions: 'write',
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  secrets: 'write',
  workflows: 'write',
} as const;

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

export const manifestFormHtml = (action: string, manifest: string): string =>
  `<!doctype html><html><body><form id="m" action="${escapeAttribute(action)}" method="post"><input type="hidden" name="manifest" value="${escapeAttribute(manifest)}"><noscript><button type="submit">Create GitHub App</button></noscript></form><script>document.getElementById("m").submit()</script></body></html>`;

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

const waitForCode = (
  formHtml: (port: number) => string,
): Promise<{ readonly code: string; readonly port: number }> =>
  new Promise((resolvePromise, rejectPromise) => {
    const server = createServer((incoming, response) => {
      const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        response.writeHead(HTTP_OK, { 'content-type': 'text/html' });
        response.end(
          '<!doctype html><html><body>App created. You can close this tab and return to the terminal.</body></html>',
        );
        if (code !== null) {
          clearTimeout(timeout);
          server.close();
          resolvePromise({
            code,
            port: (server.address() as AddressInfo).port,
          });
        }
        return;
      }
      response.writeHead(HTTP_OK, { 'content-type': 'text/html' });
      response.end(formHtml((server.address() as AddressInfo).port));
    });
    const timeout = setTimeout(() => {
      server.close();
      rejectPromise(
        new Error('timed out waiting for the GitHub App creation redirect'),
      );
    }, LOGIN_TIMEOUT_MS);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}/`;
      console.log(`Open ${url} and click "Create GitHub App".`);
      openInBrowser(url);
    });
  });

export const runCredsLoginGithub = async (options: {
  readonly name: string | undefined;
  readonly org: string | undefined;
}): Promise<boolean> => {
  const storePath = resolveBrokerPath();
  const store = await readBrokerStore(storePath);
  if (store.github !== null) {
    console.error(
      `standards creds: a broker GitHub App is already configured (${store.github.htmlUrl}); remove the "github" section from ${storePath} to re-run login`,
    );
    return false;
  }
  const action =
    options.org === undefined
      ? 'https://github.com/settings/apps/new'
      : `https://github.com/organizations/${options.org}/settings/apps/new`;
  const name = options.name ?? 'standards-broker';
  const { code } = await waitForCode((port) =>
    manifestFormHtml(
      action,
      JSON.stringify(
        buildAppManifest(name, `http://127.0.0.1:${port}/callback`),
      ),
    ),
  );
  const conversion = await request(
    null,
    'POST',
    `/app-manifest/${code}/conversions`,
  );
  if (conversion.status !== HTTP_CREATED) {
    console.error(
      `standards creds: manifest conversion failed with HTTP ${conversion.status}`,
    );
    return false;
  }
  const app = parseConversion(conversion.body);
  if (app === null) {
    console.error(
      'standards creds: manifest conversion returned an unexpected shape',
    );
    return false;
  }
  await writeBrokerStore(storePath, { ...store, github: app });
  console.log(
    `standards creds: created GitHub App ${app.slug} (${app.htmlUrl})`,
  );
  console.log(`  credentials stored in ${storePath}`);
  const installUrl = `${app.htmlUrl}/installations/new`;
  console.log(
    `Install it on your repositories (choose "All repositories" for the full broker): ${installUrl}`,
  );
  openInBrowser(installUrl);
  return true;
};
