import { runCredsAddCloudflare } from './creds-add';
import { runCredsAddGithub } from './creds-add-github';
import { parseCredsArgs } from './creds-args';
import { listPermissionGroups } from './creds-cloudflare';
import { runCredsLoginCloudflare } from './creds-login-cloudflare';
import { runCredsLoginGithub } from './creds-login-github';
import { BROKER_IDENTITY_NAME } from './creds-naming';
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
  --bucket <name>       Scope a Cloudflare token to one R2 bucket
  --jurisdiction <name> R2 jurisdiction: default or eu (default: default)
  --s3                  Store the derived R2 S3 credential pair (<key>.access_key_id, <key>.secret_access_key) instead of the raw token
  --org <org>           Create the GitHub App under an organization
  --name <name>         GitHub App name (default: ${BROKER_IDENTITY_NAME})

Secret values are written directly into SOPS-encrypted targets and never printed.`;
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
