import { resolve } from 'node:path';
import process from 'node:process';
import { runCredsAddCloudflare } from './creds-add';
import { runCredsAddGithub } from './creds-add-github';
import { listPermissionGroups } from './creds-cloudflare';
import { runCredsLoginCloudflare } from './creds-login-cloudflare';
import { runCredsLoginGithub } from './creds-login-github';
import { runCredsPlan } from './creds-plan-run';
import {
  inspectBrokerFileMode,
  readBrokerStore,
  resolveBrokerPath,
} from './creds-store';

const CREDS_USAGE = `Usage: standards creds <command> [options]

Commands:
  login github      Create the broker GitHub App via the manifest flow (one click) and store its credentials
  login cloudflare  Store a Cloudflare account's bootstrap token (one guided paste per account)
  add cloudflare    Mint a scoped, expiring account token and write it into a SOPS target
  add github        Write the broker App's credentials into a SOPS target for runtime token minting
  plan              Show revocations and rotations reconciling SOPS keys against brokered tokens
  apply             Execute the plan: revoke orphaned tokens, roll expiring ones into SOPS
  permissions       List Cloudflare permission group names for --permissions
  status            Show the broker store location and configured providers

Options:
  --dir <path>          Repository to operate on (default: current directory)
  --dest <target>:<key> SOPS destination, e.g. ci:ci.cloudflare_dns_token
  --permissions <list>  Comma-separated Cloudflare permission group names
  --account <id>        Cloudflare account when more than one is configured
  --ttl-days <n>        Token lifetime in days (default: 90)
  --org <org>           Create the GitHub App under an organization
  --name <name>         GitHub App name (default: standards-broker)

Secret values are written directly into SOPS-encrypted targets and never printed.`;
const DAY_MS = 86_400_000;
const MAX_PROVIDER_EXPIRATION_MS = Date.parse('9999-12-31T23:59:59.999Z');
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;

type CredsFlags = {
  dir: string;
  dest: string | undefined;
  permissions: string | undefined;
  account: string | undefined;
  ttlDays: number | undefined;
  org: string | undefined;
  name: string | undefined;
  readonly words: Array<string>;
};

const flagValue = (argv: ReadonlyArray<string>, index: number): string => {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${argv[index]} requires a value`);
  }
  return value;
};

export const parseTtlDays = (raw: string): number => {
  const ttlDays = Number(raw);
  if (
    !(POSITIVE_INTEGER.test(raw) && Number.isSafeInteger(ttlDays)) ||
    Date.now() + ttlDays * DAY_MS > MAX_PROVIDER_EXPIRATION_MS
  ) {
    throw new Error('--ttl-days must be a provider-safe positive integer');
  }
  return ttlDays;
};

const parseCredsArgs = (argv: ReadonlyArray<string>): CredsFlags => {
  const flags: CredsFlags = {
    dir: process.cwd(),
    dest: undefined,
    permissions: undefined,
    account: undefined,
    ttlDays: undefined,
    org: undefined,
    name: undefined,
    words: [],
  };
  const setters: Readonly<Record<string, (value: string) => void>> = {
    '--dir': (value) => {
      flags.dir = value;
    },
    '--dest': (value) => {
      flags.dest = value;
    },
    '--permissions': (value) => {
      flags.permissions = value;
    },
    '--account': (value) => {
      flags.account = value;
    },
    '--ttl-days': (value) => {
      flags.ttlDays = parseTtlDays(value);
    },
    '--org': (value) => {
      flags.org = value;
    },
    '--name': (value) => {
      flags.name = value;
    },
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const setter = setters[arg];
    if (setter !== undefined) {
      setter(flagValue(argv, index));
      index += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown creds option: ${arg}`);
    } else {
      flags.words.push(arg);
    }
  }
  flags.dir = resolve(flags.dir);
  return flags;
};

const runCredsStatus = async (): Promise<boolean> => {
  const path = resolveBrokerPath();
  const store = await readBrokerStore(path);
  console.log(`broker store: ${path}`);
  const mode = inspectBrokerFileMode(path);
  if (!mode.exists) {
    console.log('  (not created yet)');
  } else if (mode.problem !== null) {
    console.log(`  WARNING: ${mode.problem}`);
  }
  console.log(
    store.github === null
      ? 'github: not configured (`standards creds login github`)'
      : `github: App ${store.github.slug} (id ${store.github.appId}) — ${store.github.htmlUrl}`,
  );
  console.log(
    store.cloudflare.length === 0
      ? 'cloudflare: not configured (`standards creds login cloudflare`)'
      : `cloudflare: ${store.cloudflare.map((entry) => entry.accountId).join(', ')}`,
  );
  return true;
};

const runCredsPermissions = async (
  account: string | undefined,
): Promise<boolean> => {
  const store = await readBrokerStore(resolveBrokerPath());
  const selected =
    account === undefined && store.cloudflare.length === 1
      ? store.cloudflare[0]
      : store.cloudflare.find((entry) => entry.accountId === account);
  if (selected === undefined) {
    console.error(
      'standards creds: configure an account with `standards creds login cloudflare` (pass --account when several are configured)',
    );
    return false;
  }
  const groups = await listPermissionGroups(selected.accountId, selected.token);
  if (!groups.ok) {
    console.error(`standards creds: ${groups.problem}`);
    return false;
  }
  for (const group of [...groups.value].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    console.log(group.name);
  }
  return true;
};

export const runCredsCommand = (
  argv: ReadonlyArray<string>,
): Promise<boolean> => {
  const flags = parseCredsArgs(argv);
  const route = flags.words.join(' ');
  if (route === '' || route === 'help') {
    console.log(CREDS_USAGE);
    return Promise.resolve(route === 'help');
  }
  const handlers: Readonly<Record<string, () => Promise<boolean>>> = {
    'login github': () =>
      runCredsLoginGithub({ name: flags.name, org: flags.org }),
    'login cloudflare': () =>
      runCredsLoginCloudflare({ account: flags.account }),
    'add cloudflare': () => runCredsAddCloudflare(flags.dir, flags),
    'add github': () => runCredsAddGithub(flags.dir, flags),
    plan: () => runCredsPlan(flags.dir, false),
    apply: () => runCredsPlan(flags.dir, true),
    permissions: () => runCredsPermissions(flags.account),
    status: () => runCredsStatus(),
  };
  const handler = handlers[route];
  if (handler === undefined) {
    console.error(`standards creds: unknown command: ${route}\n`);
    console.error(CREDS_USAGE);
    return Promise.resolve(false);
  }
  return handler();
};
