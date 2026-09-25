import { resolveGithubAppOwner } from './creds-github-app-api';
import {
  type BrokerStore,
  type GithubBrokerApp,
  readBrokerStore,
  updateBrokerStore,
} from './creds-store';

type GithubAppsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: string };

export const sameGithubApp = (
  left: GithubBrokerApp,
  right: GithubBrokerApp,
): boolean =>
  left.owner?.toLowerCase() === right.owner?.toLowerCase() &&
  left.appId === right.appId &&
  left.slug === right.slug &&
  left.htmlUrl === right.htmlUrl &&
  left.clientId === right.clientId &&
  left.privateKey === right.privateKey;

export const loadOwnedGithubStore = async (
  path: string,
  lookupOwner: (
    app: GithubBrokerApp,
  ) => Promise<GithubAppsResult<string>> = resolveGithubAppOwner,
): Promise<GithubAppsResult<BrokerStore>> => {
  const initial = await readBrokerStore(path);
  const legacy = initial.github.find((app) => app.owner === null);
  if (legacy === undefined) {
    return { ok: true, value: initial };
  }
  const owner = await lookupOwner(legacy);
  if (!owner.ok) {
    return {
      ok: false,
      problem: `cannot migrate the legacy singleton GitHub App in ${path}: ${owner.problem}`,
    };
  }
  await updateBrokerStore(path, (current) => ({
    ...current,
    github: current.github.map((app) =>
      app.owner === null && sameGithubApp(app, legacy)
        ? { ...app, owner: owner.value }
        : app,
    ),
  }));
  const migrated = await readBrokerStore(path);
  if (migrated.github.some((app) => app.owner === null)) {
    return {
      ok: false,
      problem: `the GitHub App in ${path} changed while its legacy owner was being migrated; retry`,
    };
  }
  return { ok: true, value: migrated };
};

// Refresh authenticated metadata before selecting by a mutable owner login.
// Owner changes are committed together, and concurrent credential replacement
// aborts the refresh rather than attaching stale metadata to a different App.
export const refreshOwnedGithubStore = async (
  path: string,
  lookupOwner: (
    app: GithubBrokerApp,
  ) => Promise<GithubAppsResult<string>> = resolveGithubAppOwner,
  requestedOwner?: string,
): Promise<GithubAppsResult<BrokerStore>> => {
  const loaded = await loadOwnedGithubStore(path, lookupOwner);
  if (!loaded.ok) {
    return loaded;
  }
  const observed = loaded.value.github;
  const hasDirectMatch = observed.some(
    (app) => app.owner?.toLowerCase() === requestedOwner?.toLowerCase(),
  );
  const results = await Promise.all(
    observed.map((app) =>
      hasDirectMatch &&
      app.owner?.toLowerCase() !== requestedOwner?.toLowerCase()
        ? Promise.resolve({ ok: true as const, value: app.owner ?? '' })
        : lookupOwner(app),
    ),
  );
  const failed = results.find((result) => !result.ok);
  if (failed !== undefined && !failed.ok) {
    return {
      ok: false,
      problem: `cannot refresh authenticated GitHub App owners: ${failed.problem}; keep existing credentials and retry before creating another App`,
    };
  }
  const refreshed = observed.map((app, index) => {
    const result = results[index];
    return result?.ok ? { ...app, owner: result.value } : app;
  });
  if (refreshed.every((app, index) => app.owner === observed[index]?.owner)) {
    return loaded;
  }
  try {
    await updateBrokerStore(path, (current) => {
      if (
        current.github.length !== observed.length ||
        !current.github.every((app, index) => {
          const previous = observed[index];
          return previous !== undefined && sameGithubApp(app, previous);
        })
      ) {
        throw new Error(
          'GitHub Apps changed while authenticated owners were refreshed; retry',
        );
      }
      return { ...current, github: refreshed };
    });
  } catch (error) {
    return {
      ok: false,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
  return { ok: true, value: await readBrokerStore(path) };
};

// Private Apps belong to one owner. Selecting by repository owner keeps each
// owner's credentials separate; installation access is verified before export.
export const selectGithubAppForRepo = (
  apps: ReadonlyArray<GithubBrokerApp>,
  repo: string,
): GithubAppsResult<GithubBrokerApp> => {
  const owner = repo.split('/')[0] ?? '';
  const matches = apps.filter(
    (app) => app.owner?.toLowerCase() === owner.toLowerCase(),
  );
  if (matches.length === 1 && matches[0] !== undefined) {
    return { ok: true, value: matches[0] };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      problem: `multiple broker GitHub Apps are configured for repository owner ${owner}; keep exactly one entry for that owner`,
    };
  }
  const loginHint =
    apps.length === 0
      ? 'no broker GitHub Apps are configured'
      : `authenticated configured owners: ${apps.map((app) => app.owner).join(', ')}; if an account was renamed, update this checkout origin to the current owner shown here before retrying; do not create a duplicate App for a renamed account`;
  return {
    ok: false,
    problem:
      apps.length > 0
        ? `no broker GitHub App matches repository owner ${owner} (${loginHint}); verify the origin and existing App ownership before configuring a new App`
        : `no broker GitHub App is configured for repository owner ${owner} (${loginHint}); run \`standards creds login github --org ${owner}\` for an organization, or run it without --org while signed in as ${owner}`,
  };
};

export const upsertGithubApp = (
  apps: ReadonlyArray<GithubBrokerApp>,
  app: GithubBrokerApp,
): {
  readonly apps: ReadonlyArray<GithubBrokerApp>;
  readonly replaced: GithubBrokerApp | null;
} => {
  if (app.owner === null || apps.some((entry) => entry.owner === null)) {
    throw new Error('legacy GitHub Apps must be migrated before login');
  }
  const index = apps.findIndex(
    (entry) => entry.owner?.toLowerCase() === app.owner?.toLowerCase(),
  );
  if (index === -1) {
    return { apps: [...apps, app], replaced: null };
  }
  return {
    apps: apps.map((entry, entryIndex) => (entryIndex === index ? app : entry)),
    replaced: apps[index] ?? null,
  };
};
