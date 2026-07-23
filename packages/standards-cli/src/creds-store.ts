// Machine-global broker credentials for `standards creds`: the GitHub App and
// per-account Cloudflare bootstrap tokens that mint everything else. The store
// lives outside every repository as a plaintext 0600 file — the same trust
// level as the personal age identity at ~/.config/sops/age/keys.txt, which
// unlocks the same secrets; encrypting one to a key beside the other would be
// theater. Losing the file is cheap: re-run the login commands and revoke the
// old credentials.

import { chmodSync, existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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

export type CloudflareBrokerAccount = {
  readonly accountId: string;
  readonly token: string;
};

export type BrokerStore = {
  readonly github: GithubBrokerApp | null;
  readonly cloudflare: ReadonlyArray<CloudflareBrokerAccount>;
};

export const EMPTY_BROKER_STORE: BrokerStore = { github: null, cloudflare: [] };

const OWNER_ONLY_FILE_MODE = 0o600;
const OWNER_ONLY_DIR_MODE = 0o700;
const PERMISSION_MASK = 0o777;
const GROUP_OTHER_MASK = 0o077;
const OCTAL_RADIX = 8;

export type BrokerFileMode = {
  readonly exists: boolean;
  readonly problem: string | null;
};

export const inspectBrokerFileMode = (path: string): BrokerFileMode => {
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission bits are a bitmask.
    const mode = statSync(path).mode & PERMISSION_MASK;
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission bits are a bitmask.
    const groupOther = mode & GROUP_OTHER_MASK;
    return {
      exists: true,
      problem:
        groupOther === 0
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
    'standards',
    'broker.yaml',
  );

const parseGithub = (raw: unknown, path: string): GithubBrokerApp | null => {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (
    !(
      isRecord(raw) &&
      typeof raw.app_id === 'number' &&
      Number.isInteger(raw.app_id) &&
      isNonEmptyString(raw.slug) &&
      isNonEmptyString(raw.html_url) &&
      isNonEmptyString(raw.client_id) &&
      isNonEmptyString(raw.private_key)
    )
  ) {
    throw new Error(
      `${path}: "github" must carry app_id, slug, html_url, client_id, and private_key; re-run \`standards creds login github\``,
    );
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
    if (
      !(
        isRecord(entry) &&
        isNonEmptyString(entry.account_id) &&
        isNonEmptyString(entry.token)
      )
    ) {
      throw new Error(
        `${path}: each "cloudflare" entry must carry account_id and token; re-run \`standards creds login cloudflare\``,
      );
    }
    return { accountId: entry.account_id, token: entry.token };
  });
};

export const readBrokerStore = async (path: string): Promise<BrokerStore> => {
  if (!existsSync(path)) {
    return EMPTY_BROKER_STORE;
  }
  const raw = parseYaml(await readFile(path, 'utf8')) as unknown;
  if (raw === null || raw === undefined) {
    return EMPTY_BROKER_STORE;
  }
  if (!isRecord(raw)) {
    throw new Error(`${path} must contain a YAML mapping`);
  }
  return {
    github: parseGithub(raw.github, path),
    cloudflare: parseCloudflare(raw.cloudflare, path),
  };
};

export const writeBrokerStore = async (
  path: string,
  store: BrokerStore,
): Promise<void> => {
  const document = {
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
  };
  await mkdir(dirname(path), { recursive: true, mode: OWNER_ONLY_DIR_MODE });
  await writeFile(path, stringifyYaml(document), {
    mode: OWNER_ONLY_FILE_MODE,
  });
  // writeFile applies the mode only on creation; an existing file keeps its
  // permissions, so tighten explicitly on every save.
  chmodSync(path, OWNER_ONLY_FILE_MODE);
};
