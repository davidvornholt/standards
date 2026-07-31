// Shared destination validation and repository/SOPS target resolution for
// `standards creds add`. Untrusted paths are rejected before any SOPS or
// provider operation can run.

import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isContainedSopsPath, parseSopsKeyPath } from './creds-sops-structure';
import {
  type BrokerStore,
  type CloudflareBrokerAccount,
  readBrokerStore,
  resolveBrokerPath,
} from './creds-store';
import {
  isSafeSecretsTargetName,
  resolveTargetRelResult,
} from './creds-target';
import { resolveGithubRepo } from './github-api';
import { isRecord } from './github-settings-parse';

export type CredsDestination = {
  readonly target: string;
  readonly key: string;
};
export type SecretsTarget = { readonly target: string; readonly rel: string };
export type SecretsTargetInventory = {
  readonly targets: ReadonlyArray<SecretsTarget>;
  readonly problems: ReadonlyArray<string>;
};
export type ResolvedContext = {
  readonly repo: string;
  readonly rel: string;
  readonly dest: CredsDestination;
  readonly store: BrokerStore;
};

export const parseDestination = (raw: string): CredsDestination | null => {
  const separator = raw.indexOf(':');
  const target = raw.slice(0, separator);
  const key = raw.slice(separator + 1);
  return separator > 0 &&
    separator < raw.length - 1 &&
    isSafeSecretsTargetName(target) &&
    parseSopsKeyPath(key) !== null
    ? { target, key }
    : null;
};

export const assertWritableSopsPath = (
  root: Readonly<Record<string, unknown>>,
  path: ReadonlyArray<string>,
): void => {
  let node: unknown = root;
  for (const [index, segment] of path.entries()) {
    if (!isRecord(node)) {
      throw new Error(
        `SOPS key path is blocked by a scalar: ${path.join('.')}`,
      );
    }
    const next = node[segment];
    if (next === undefined) {
      return;
    }
    if (index === path.length - 1 && isRecord(next)) {
      throw new Error(`SOPS key path names a mapping: ${path.join('.')}`);
    }
    node = next;
  }
};

const isYamlSecrets = (name: string): boolean =>
  name.endsWith('.yaml') && !name.endsWith('.example.yaml');
const listDir = (consumer: string, rel: string): ReadonlyArray<string> => {
  if (!isContainedSopsPath(consumer, rel, 'directory')) {
    return [];
  }
  try {
    return readdirSync(join(consumer, rel));
  } catch {
    return [];
  }
};
const isHostTargetCandidate = (consumer: string, name: string): boolean => {
  const rel = `infra/hosts/${name}`;
  if (isContainedSopsPath(consumer, rel, 'directory')) {
    return listDir(consumer, rel).includes('secrets.yaml');
  }
  try {
    return lstatSync(join(consumer, rel)).isSymbolicLink();
  } catch {
    return false;
  }
};

export const listSecretsTargets = (
  consumer: string,
): SecretsTargetInventory => {
  const flat = listDir(consumer, 'secrets')
    .filter(isYamlSecrets)
    .map((name) => ({
      target: name.slice(0, -'.yaml'.length),
      rel: `secrets/${name}`,
    }))
    .filter(({ target }) => isSafeSecretsTargetName(target));
  const hosts = listDir(consumer, 'infra/hosts')
    .filter(
      (name) =>
        isSafeSecretsTargetName(name) && isHostTargetCandidate(consumer, name),
    )
    .map((name) => ({
      target: name,
      rel: `infra/hosts/${name}/secrets.yaml`,
    }));
  const targets = [...flat, ...hosts];
  const relsByTarget = new Map<string, Array<string>>();
  for (const { target, rel } of targets) {
    const rels = relsByTarget.get(target) ?? [];
    rels.push(rel);
    relsByTarget.set(target, rels);
  }
  const problems = [...relsByTarget.entries()].flatMap(([target, rels]) =>
    rels.length > 1
      ? [
          `secrets target "${target}" is ambiguous because ${rels.join(' and ')} both claim that identity; rename one target so the name binds exactly one encrypted file`,
        ]
      : [],
  );
  return { targets, problems };
};

export const resolveContext = async (
  consumer: string,
  destRaw: string | undefined,
): Promise<ResolvedContext | null> => {
  if (destRaw === undefined) {
    console.error(
      'standards creds: --dest <target>:<dotted.key> is required (e.g. --dest ci:ci.cloudflare_dns_token)',
    );
    return null;
  }
  const dest = parseDestination(destRaw);
  if (dest === null) {
    console.error(`standards creds: invalid --dest value: ${destRaw}`);
    return null;
  }
  const repo = resolveGithubRepo(consumer);
  if (repo === null) {
    console.error(
      'standards creds: cannot resolve the GitHub repository from the origin remote',
    );
    return null;
  }
  const resolved = resolveTargetRelResult(consumer, dest.target);
  if (!resolved.ok) {
    console.error(
      `standards creds: ${
        resolved.kind === 'missing'
          ? `${resolved.problem}; create it with \`just secrets edit ${dest.target}\` first`
          : resolved.problem
      }`,
    );
    return null;
  }
  return {
    repo,
    rel: resolved.rel,
    dest,
    store: await readBrokerStore(resolveBrokerPath()),
  };
};

export const selectAccount = (
  store: BrokerStore,
  accountId: string | undefined,
): CloudflareBrokerAccount | null => {
  if (store.cloudflare.length === 0) {
    console.error(
      'standards creds: no Cloudflare accounts configured; run `standards creds login cloudflare`',
    );
    return null;
  }
  if (accountId === undefined) {
    if (store.cloudflare.length === 1) {
      return store.cloudflare[0] ?? null;
    }
    console.error(
      `standards creds: multiple Cloudflare accounts configured; pass --account (${store.cloudflare.map((entry) => entry.accountId).join(', ')})`,
    );
    return null;
  }
  const account = store.cloudflare.find(
    (entry) => entry.accountId === accountId,
  );
  if (account === undefined) {
    console.error(`standards creds: account ${accountId} is not configured`);
  }
  return account ?? null;
};
