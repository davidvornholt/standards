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
import { resolveGithubRepo } from './github-api';
import { isRecord } from './github-settings-parse';

const SAFE_TARGET = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/u;

export type CredsDestination = {
  readonly target: string;
  readonly key: string;
};
export type SecretsTarget = { readonly target: string; readonly rel: string };
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
    SAFE_TARGET.test(target) &&
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
): ReadonlyArray<SecretsTarget> => {
  const flat = listDir(consumer, 'secrets')
    .filter(isYamlSecrets)
    .map((name) => ({
      target: name.slice(0, -'.yaml'.length),
      rel: `secrets/${name}`,
    }))
    .filter(({ target }) => SAFE_TARGET.test(target));
  const hosts = listDir(consumer, 'infra/hosts')
    .filter(
      (name) => SAFE_TARGET.test(name) && isHostTargetCandidate(consumer, name),
    )
    .map((name) => ({
      target: name,
      rel: `infra/hosts/${name}/secrets.yaml`,
    }));
  return [...flat, ...hosts];
};

export const resolveTargetRel = (
  consumer: string,
  target: string,
): string | null => {
  if (!SAFE_TARGET.test(target)) {
    return null;
  }
  const host = `infra/hosts/${target}/secrets.yaml`;
  if (isContainedSopsPath(consumer, host, 'file')) {
    return host;
  }
  const flat = `secrets/${target}.yaml`;
  return isContainedSopsPath(consumer, flat, 'file') ? flat : null;
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
  const rel = resolveTargetRel(consumer, dest.target);
  if (rel === null) {
    console.error(
      `standards creds: secrets target "${dest.target}" not found; create it with \`just secrets edit ${dest.target}\` first`,
    );
    return null;
  }
  return { repo, rel, dest, store: await readBrokerStore(resolveBrokerPath()) };
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
