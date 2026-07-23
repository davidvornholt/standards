import { randomBytes } from 'node:crypto';
import { openInBrowser } from './creds-browser';
import {
  buildAppManifest,
  convertManifestCode,
  createManifestState,
  MANIFEST_STATE_BYTES,
  manifestFormHtml,
} from './creds-login-github-manifest';
import { BROKER_IDENTITY_NAME } from './creds-naming';
import {
  readBrokerStore,
  resolveBrokerPath,
  updateBrokerStore,
} from './creds-store';

const LOGIN_TIMEOUT_MS = 600_000;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;

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
  const name = options.name ?? BROKER_IDENTITY_NAME;
  const code = await waitForCode((port, state) =>
    manifestFormHtml(
      action,
      JSON.stringify(
        buildAppManifest(name, `http://127.0.0.1:${port}/callback`),
      ),
      state,
    ),
  );
  const conversion = await convertManifestCode(code);
  if (!conversion.ok) {
    console.error(`standards creds: ${conversion.problem}`);
    return false;
  }
  const { app } = conversion;
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
