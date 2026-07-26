import { randomBytes } from 'node:crypto';
import { openInBrowser } from './creds-browser';
import {
  loadOwnedGithubStore,
  sameGithubApp,
  upsertGithubApp,
} from './creds-github-apps';
import {
  buildAppManifest,
  convertManifestCode,
  createManifestState,
  MANIFEST_STATE_BYTES,
  manifestFormHtml,
  resolveGithubAppName,
} from './creds-login-github-manifest';
import {
  type GithubBrokerApp,
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

type GithubLoginDependencies = {
  readonly waitForCode: typeof waitForCode;
  readonly convertManifestCode: typeof convertManifestCode;
  readonly openInBrowser: typeof openInBrowser;
};

const DEFAULT_LOGIN_DEPENDENCIES: GithubLoginDependencies = {
  waitForCode,
  convertManifestCode,
  openInBrowser,
};

export const runCredsLoginGithub = async (
  options: {
    readonly name: string | undefined;
    readonly org: string | undefined;
  },
  dependencies: GithubLoginDependencies = DEFAULT_LOGIN_DEPENDENCIES,
): Promise<boolean> => {
  const resolvedName = resolveGithubAppName(options.name, options.org);
  if (!resolvedName.ok) {
    console.error(`standards creds: ${resolvedName.problem}`);
    return false;
  }
  const storePath = resolveBrokerPath();
  const loaded = await loadOwnedGithubStore(storePath);
  if (!loaded.ok) {
    console.error(`standards creds: ${loaded.problem}`);
    return false;
  }
  const action =
    options.org === undefined
      ? 'https://github.com/settings/apps/new'
      : `https://github.com/organizations/${options.org}/settings/apps/new`;
  const code = await dependencies.waitForCode((port, state) =>
    manifestFormHtml(
      action,
      JSON.stringify(
        buildAppManifest(
          resolvedName.value,
          `http://127.0.0.1:${port}/callback`,
        ),
      ),
      state,
    ),
  );
  const conversion = await dependencies.convertManifestCode(code);
  if (!conversion.ok) {
    console.error(`standards creds: ${conversion.problem}`);
    return false;
  }
  const { app } = conversion;
  const observed = loaded.value.github.find(
    (entry) => entry.owner?.toLowerCase() === app.owner?.toLowerCase(),
  );
  let replaced: GithubBrokerApp | undefined;
  try {
    await updateBrokerStore(storePath, (current) => {
      const currentEntry = current.github.find(
        (entry) => entry.owner?.toLowerCase() === app.owner?.toLowerCase(),
      );
      const unchanged =
        observed === undefined
          ? currentEntry === undefined
          : currentEntry !== undefined && sameGithubApp(currentEntry, observed);
      if (!unchanged) {
        throw new Error(
          `the broker App for ${app.owner} changed while this App was being created`,
        );
      }
      const upserted = upsertGithubApp(current.github, app);
      replaced = upserted.replaced ?? undefined;
      return { ...current, github: upserted.apps };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `standards creds: the newly created App ${app.htmlUrl} was not stored (${message}); retry login, and delete the new App if it is still absent from \`creds status\``,
    );
    return false;
  }
  console.log(
    `standards creds: created App ${app.slug} for ${app.owner} (${app.htmlUrl})`,
  );
  console.log(`  credentials stored in ${storePath}`);
  if (replaced !== undefined) {
    console.log(
      `  replaced App ${replaced.slug} for ${app.owner}; update its SOPS destinations, verify token minting, then delete the old App`,
    );
  }
  const installUrl = `${app.htmlUrl}/installations/new`;
  console.log(githubInstallMessage(installUrl));
  dependencies.openInBrowser(installUrl);
  return true;
};
