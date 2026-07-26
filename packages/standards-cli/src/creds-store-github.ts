import { isNonEmptyString, isRecord } from './github-settings-parse';

export type GithubBrokerApp = {
  readonly owner: string | null;
  readonly appId: number;
  readonly slug: string;
  readonly htmlUrl: string;
  readonly clientId: string;
  readonly privateKey: string;
};

const parseGithubApp = (
  raw: unknown,
  owner: string | null,
): GithubBrokerApp => {
  if (
    !isRecord(raw) ||
    typeof raw.app_id !== 'number' ||
    !Number.isInteger(raw.app_id) ||
    !isNonEmptyString(raw.slug) ||
    !isNonEmptyString(raw.html_url) ||
    !isNonEmptyString(raw.client_id) ||
    !isNonEmptyString(raw.private_key)
  ) {
    throw new Error('invalid github: run `standards creds login github`');
  }
  return {
    owner,
    appId: raw.app_id,
    slug: raw.slug,
    htmlUrl: raw.html_url,
    clientId: raw.client_id,
    privateKey: raw.private_key,
  };
};

export const validateGithubApps = (
  apps: ReadonlyArray<GithubBrokerApp>,
  path: string,
): ReadonlyArray<GithubBrokerApp> => {
  const owners = new Set<string>();
  const appIds = new Set<number>();
  for (const app of apps) {
    if (app.owner === null) {
      if (apps.length !== 1) {
        throw new Error(
          `${path}: the ownerless legacy GitHub App must be migrated before another App can be stored`,
        );
      }
    } else {
      const owner = app.owner.toLowerCase();
      if (owners.has(owner)) {
        throw new Error(
          `${path}: duplicate GitHub owner ${app.owner}; keep one broker App per account`,
        );
      }
      owners.add(owner);
    }
    if (appIds.has(app.appId)) {
      throw new Error(
        `${path}: duplicate GitHub App id ${app.appId}; keep each App once`,
      );
    }
    appIds.add(app.appId);
  }
  return apps;
};

export const parseGithubApps = (
  raw: unknown,
  path: string,
): ReadonlyArray<GithubBrokerApp> => {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return [parseGithubApp(raw, null)];
  }
  const apps = raw.map((entry) => {
    if (!(isRecord(entry) && isNonEmptyString(entry.owner))) {
      throw new Error(
        'invalid github owner: run `standards creds login github`',
      );
    }
    return parseGithubApp(entry, entry.owner);
  });
  return validateGithubApps(apps, path);
};

const appDocument = (
  app: GithubBrokerApp,
): Readonly<Record<string, unknown>> => ({
  ...(app.owner === null ? {} : { owner: app.owner }),
  // biome-ignore lint/style/useNamingConvention: The persisted broker YAML contract uses snake_case.
  app_id: app.appId,
  slug: app.slug,
  // biome-ignore lint/style/useNamingConvention: The persisted broker YAML contract uses snake_case.
  html_url: app.htmlUrl,
  // biome-ignore lint/style/useNamingConvention: The persisted broker YAML contract uses snake_case.
  client_id: app.clientId,
  // biome-ignore lint/style/useNamingConvention: The persisted broker YAML contract uses snake_case.
  private_key: app.privateKey,
});

export const githubStoreDocument = (
  apps: ReadonlyArray<GithubBrokerApp>,
): unknown =>
  apps.length === 1 && apps[0]?.owner === null
    ? appDocument(apps[0])
    : apps.map(appDocument);
