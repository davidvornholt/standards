import { randomBytes, timingSafeEqual } from 'node:crypto';
import { openInBrowser } from './creds-browser';
import {
  type GithubBrokerApp,
  readBrokerStore,
  resolveBrokerPath,
  updateBrokerStore,
} from './creds-store';
import { HTTP_CREATED, request } from './github-api';
import { isRecord } from './github-settings-parse';

const LOGIN_TIMEOUT_MS = 600_000;
const MANIFEST_STATE_BYTES = 32;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
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

export const startManifestLoginListener = (
  formHtml: (port: number, state: string) => string,
  timeoutMs = LOGIN_TIMEOUT_MS,
) => {
  const state = createManifestState();
  const startPath = `/start/${randomBytes(MANIFEST_STATE_BYTES).toString('hex')}`;
  let startAvailable = true;
  const deferred = Promise.withResolvers<string>();
  // biome-ignore lint/correctness/noUndeclaredVariables: Bun is the CLI's required runtime.
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (incoming, activeServer): Response => {
      const url = new URL(incoming.url);
      if (incoming.method === 'GET' && url.pathname === '/callback') {
        const callbackCode = url.searchParams.get('code');
        if (
          callbackCode !== null &&
          state.accept(url.searchParams.get('state'))
        ) {
          deferred.resolve(callbackCode);
          return new Response('GitHub App created. Return to the terminal.');
        }
        return new Response(null, { status: HTTP_BAD_REQUEST });
      }
      if (
        incoming.method === 'GET' &&
        startAvailable &&
        url.pathname === startPath
      ) {
        startAvailable = false;
        return new Response(formHtml(Number(activeServer.port), state.value), {
          headers: { 'cache-control': 'no-store', 'content-type': 'text/html' },
        });
      }
      return new Response('Not found.', { status: HTTP_NOT_FOUND });
    },
  });
  let timeout: ReturnType<typeof setTimeout>;
  const close = (): void => {
    clearTimeout(timeout);
    server.stop();
  };
  timeout = setTimeout(() => {
    close();
    deferred.reject(
      new Error('timed out waiting for the GitHub App creation redirect'),
    );
  }, timeoutMs);
  return {
    startUrl: `http://127.0.0.1:${server.port}${startPath}`,
    code: deferred.promise,
    close,
  };
};
export const waitForCode = (
  formHtml: (port: number, state: string) => string,
  opener: typeof openInBrowser = openInBrowser,
): Promise<string> => {
  const listener = startManifestLoginListener(formHtml);
  console.log(`Open ${listener.startUrl} to create the GitHub App.`);
  opener(listener.startUrl);
  return listener.code.finally(listener.close);
};
export const githubInstallMessage = (installUrl: string): string =>
  `Install it only on the selected repositories that need broker credentials: ${installUrl}`;
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
      `standards creds: conversion failed: HTTP ${conversion.status}`,
    );
    return false;
  }
  const app = parseConversion(conversion.body);
  if (app === null) {
    console.error('standards creds: unexpected manifest conversion response');
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
  console.log(`standards creds: created App ${app.slug} (${app.htmlUrl})`);
  console.log(`  credentials stored in ${storePath}`);
  const installUrl = `${app.htmlUrl}/installations/new`;
  console.log(githubInstallMessage(installUrl));
  openInBrowser(installUrl);
  return true;
};
