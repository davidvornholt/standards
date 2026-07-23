import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, open, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { isNonEmptyString, isRecord } from './github-settings-parse';
export type GithubBrokerApp = {
  readonly appId: number;
  readonly slug: string;
  readonly htmlUrl: string;
  readonly clientId: string;
  readonly privateKey: string;
};
export type CloudflareBrokerAccount = Readonly<
  Record<'accountId' | 'token', string>
>;
export type BrokerStore = {
  readonly github: GithubBrokerApp | null;
  readonly cloudflare: ReadonlyArray<CloudflareBrokerAccount>;
};
export const EMPTY_BROKER_STORE: BrokerStore = { github: null, cloudflare: [] };
const OWNER_ONLY_FILE_MODE = 0o600;
const OWNER_ONLY_DIR_MODE = 0o700;
const FILE_MODE_MODULUS = 0o1000;
const GROUP_OTHER_MODULUS = 0o100;
const OCTAL_RADIX = 8;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
export const inspectBrokerFileMode = (path: string) => {
  try {
    const mode = statSync(path).mode % FILE_MODE_MODULUS;
    return {
      exists: true,
      problem:
        mode % GROUP_OTHER_MODULUS === 0
          ? null
          : `mode ${mode.toString(OCTAL_RADIX)} is broader than 0600; tighten with chmod 600`,
    };
  } catch {
    return { exists: false, problem: null };
  }
};
export const resolveBrokerPath = (): string =>
  process.env.STANDARDS_BROKER_FILE ??
  join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'standards/broker.yaml',
  );
const parseGithub = (raw: unknown): GithubBrokerApp | null => {
  if (raw === undefined || raw === null) {
    return null;
  }
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
    appId: raw.app_id,
    slug: raw.slug,
    htmlUrl: raw.html_url,
    clientId: raw.client_id,
    privateKey: raw.private_key,
  };
};
const parseCloudflare = (
  raw: unknown,
  path: string,
): ReadonlyArray<CloudflareBrokerAccount> => {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error(`${path}: "cloudflare" must be a list of accounts`);
  }
  return raw.map((entry) => {
    const valid =
      isRecord(entry) &&
      isNonEmptyString(entry.account_id) &&
      isNonEmptyString(entry.token);
    if (!valid) {
      throw new Error(
        'invalid cloudflare: run `standards creds login cloudflare`',
      );
    }
    return { accountId: String(entry.account_id), token: String(entry.token) };
  });
};
export const readBrokerStore = async (path: string): Promise<BrokerStore> => {
  const raw = existsSync(path)
    ? (parseYaml(await readFile(path, 'utf8')) as unknown)
    : null;
  if (raw === null || raw === undefined) {
    return EMPTY_BROKER_STORE;
  }
  if (!isRecord(raw)) {
    throw new Error(`${path} must contain a YAML mapping`);
  }
  return {
    github: parseGithub(raw.github),
    cloudflare: parseCloudflare(raw.cloudflare, path),
  };
};
export const updateBrokerStore = async (
  path: string,
  update: (store: BrokerStore) => BrokerStore | Promise<BrokerStore>,
  sync: typeof syncDirectory = syncDirectory,
): Promise<void> =>
  withBrokerLock(path, async () => {
    const store = await update(await readBrokerStore(path));
    await writeBrokerStoreUnlocked(path, store, sync);
  });
const storeDocument = (store: BrokerStore): unknown => ({
  ...(store.github === null
    ? {}
    : {
        github: {
          app_id: store.github.appId,
          slug: store.github.slug,
          html_url: store.github.htmlUrl,
          client_id: store.github.clientId,
          private_key: store.github.privateKey,
        },
      }),
  ...(store.cloudflare.length === 0
    ? {}
    : {
        cloudflare: store.cloudflare.map((account) => ({
          account_id: account.accountId,
          token: account.token,
        })),
      }),
});
const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};
const writeBrokerStoreUnlocked = async (
  path: string,
  store: BrokerStore,
  sync: typeof syncDirectory,
): Promise<void> => {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', OWNER_ONLY_FILE_MODE);
  try {
    try {
      await handle.writeFile(stringifyYaml(storeDocument(store)), 'utf8');
      await handle.chmod(OWNER_ONLY_FILE_MODE);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await sync(parent);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
};
const withBrokerLock = async <T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: OWNER_ONLY_DIR_MODE });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: lock retries must be sequential.
      await mkdir(lockPath, { mode: OWNER_ONLY_DIR_MODE });
      break;
    } catch (error) {
      if (!(isRecord(error) && error.code === 'EEXIST')) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`lock timeout: ${lockPath}`, { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  try {
    return await operation();
  } finally {
    await rmdir(lockPath);
  }
};
