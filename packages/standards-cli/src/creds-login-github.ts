// Bootstrap the broker's GitHub root through the App manifest browser flow;
// conversion credentials never need to be displayed or pasted.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openInBrowser } from './creds-browser';
import {
  type GithubBrokerApp,
  readBrokerStore,
  resolveBrokerPath,
  updateBrokerStore,
} from './creds-store';
import { HTTP_CREATED, HTTP_OK, request } from './github-api';
import { isRecord } from './github-settings-parse';

const LOGIN_TIMEOUT_MS = 600_000;
const MANIFEST_STATE_BYTES = 32;
const HTTP_BAD_REQUEST = 400;
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
export const createManifestState = (): {
  readonly value: string;
  readonly accept: (candidate: string | null) => boolean;
} => {
  const expected = randomBytes(MANIFEST_STATE_BYTES);
  let available = true;
  return {
    value: expected.toString('hex'),
    accept: (candidate) => {
      const received =
        candidate === null ? Buffer.alloc(0) : Buffer.from(candidate, 'hex');
      const matches =
        available &&
        received.length === expected.length &&
        timingSafeEqual(received, expected);
      if (matches) {
        available = false;
      }
      return matches;
    },
  };
};
export const manifestFormHtml = (
  action: string,
  manifest: string,
  state: string,
): string => {
  const target = new URL(action);
  target.searchParams.set('state', state);
  return `<!doctype html><html><body><form id="m" action="${escapeAttribute(target.href)}" method="post"><input type="hidden" name="manifest" value="${escapeAttribute(manifest)}"><noscript><button type="submit">Create GitHub App</button></noscript></form><script>document.getElementById("m").submit()</script></body></html>`;
};
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
  formHtml: (port: number, state: string) => string,
): Promise<string> =>
  new Promise((resolvePromise, rejectPromise) => {
    const state = createManifestState();
    const server = createServer((incoming, response) => {
      const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        if (code !== null && state.accept(url.searchParams.get('state'))) {
          response.writeHead(HTTP_OK, { 'content-type': 'text/html' });
          response.end(
            '<!doctype html><html><body>App created. You can close this tab and return to the terminal.</body></html>',
          );
          clearTimeout(timeout);
          server.close();
          resolvePromise(code);
        } else {
          response.writeHead(HTTP_BAD_REQUEST, {
            'content-type': 'text/plain',
          });
          response.end(
            'This callback does not match the GitHub App login request.',
          );
        }
        return;
      }
      response.writeHead(HTTP_OK, { 'content-type': 'text/html' });
      response.end(
        formHtml((server.address() as AddressInfo).port, state.value),
      );
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
  const code = await waitForCode((port, state) =>
    manifestFormHtml(
      action,
      JSON.stringify(
        buildAppManifest(name, `http://127.0.0.1:${port}/callback`),
      ),
      state,
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
  await updateBrokerStore(storePath, (current) => {
    if (current.github !== null) {
      throw new Error(
        `a broker GitHub App was configured while login was in progress (${current.github.htmlUrl}); the newly created App ${app.htmlUrl} was not stored and should be deleted`,
      );
    }
    return { ...current, github: app };
  });
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
