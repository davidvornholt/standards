import { runCredsAddCloudflare } from './creds-add';
import { runCredsAddGithub } from './creds-add-github';
import { parseCredsArgs } from './creds-args';
import { listPermissionGroups } from './creds-cloudflare';
import { loadOwnedGithubStore } from './creds-github-apps';
import { runCredsLoginCloudflare } from './creds-login-cloudflare';
import { runCredsLoginGithub } from './creds-login-github';
import { BROKER_IDENTITY_NAME } from './creds-naming';
import { runCredsPlan } from './creds-plan-run';
import { runCredsRevoke } from './creds-revoke';
import {
  inspectBrokerFileMode,
  readBrokerStore,
  resolveBrokerPath,
} from './creds-store';

const CREDS_USAGE = `Usage: standards creds <command> [options]

Commands:
  login github      Create or replace one account's broker GitHub App via the manifest flow
  login cloudflare  Store a Cloudflare account's bootstrap token (one guided paste per account)
  add cloudflare    Mint a scoped, expiring account token and write it into a SOPS target
  add github        Select the repository owner's App, verify its installation, and write it into SOPS
  plan              Reconcile SOPS keys against brokered tokens: show revocations, rotations, and the live account tokens nothing reconciles here
  apply             Execute the plan: revoke brokered tokens whose SOPS key is gone, roll expiring ones into SOPS
  revoke            Delete one Cloudflare token named by --token-id; bootstrap credentials and brokered tokens are refused
  permissions       List Cloudflare permission group names for --permissions
  status            Show the broker store location and configured providers

Options:
  --dir <path>          Repository to operate on (default: current directory)
  --dest <target>:<key> SOPS destination, e.g. ci:ci.cloudflare_dns_token
  --permissions <list>  Comma-separated Cloudflare permission group names
  --account <id>        Cloudflare account when more than one is configured
  --ttl-days <n>        Token lifetime in days (default: 90)
  --bucket <name>       Scope a Cloudflare token to one R2 bucket
  --zone <zone-id>      Add a zone resource for zone-scoped groups (comma-separated IDs)
  --jurisdiction <name> R2 jurisdiction: default or eu (default: default)
  --s3                  Store the derived R2 S3 credential pair (<key>.access_key_id, <key>.secret_access_key) instead of the raw token
  --token-id <id>       Cloudflare token to revoke (32-character hexadecimal ID)
  --force               Let revoke delete a token brokered to a repository that is not this checkout's. It verifies nothing about that repository, so use it only when nothing reconciles the token any more: that repository was renamed, transferred, or deleted, so no checkout resolves to its name and no \`standards creds apply\` will ever revoke the token. It never permits revoking a broker bootstrap credential, a token brokered to this repository, a token whose brokered repository differs from this checkout's only in capitalisation, or any brokered token when this checkout's origin remote resolves to no GitHub repository, because ownership is then the very thing that could not be checked
  --org <org>           Create the GitHub App under an organization
  --name <name>         GitHub App name (default: ${BROKER_IDENTITY_NAME}, suffixed by --org)

Secret values are written directly into SOPS-encrypted targets and never printed.`;
const runCredsStatus = async (): Promise<boolean> => {
  const path = resolveBrokerPath();
  const loaded = await loadOwnedGithubStore(path);
  if (!loaded.ok) {
    console.error(`standards creds: ${loaded.problem}`);
    return false;
  }
  const { value: store } = loaded;
  console.log(`broker store: ${path}`);
  const mode = inspectBrokerFileMode(path);
  if (!mode.exists) {
    console.log('  (not created yet)');
  } else if (mode.problem !== null) {
    console.log(`  WARNING: ${mode.problem}`);
  }
  if (store.github.length === 0) {
    console.log('github: not configured (`standards creds login github`)');
  } else {
    console.log('github:');
    for (const app of store.github) {
      console.log(
        `  ${app.owner}: App ${app.slug} (id ${app.appId}) — ${app.htmlUrl}`,
      );
    }
  }
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
    revoke: () =>
      runCredsRevoke({
        account: flags.account,
        tokenId: flags.tokenId,
        dir: flags.dir,
        force: flags.force,
      }),
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
