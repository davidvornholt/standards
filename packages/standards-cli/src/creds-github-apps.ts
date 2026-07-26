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
      : `configured owners: ${apps.map((app) => app.owner).join(', ')}`;
  return {
    ok: false,
    problem: `no broker GitHub App is configured for repository owner ${owner} (${loginHint}); run \`standards creds login github --org ${owner}\` for an organization, or run it without --org while signed in as ${owner}`,
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
