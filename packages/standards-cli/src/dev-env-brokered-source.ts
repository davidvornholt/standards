import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDestination } from './creds-dest';
import { resolveTargetRelResult } from './creds-target';
import type { BrokeredS3Reference } from './dev-env-brokered';
import { isRecord } from './github-settings-parse';

const repositoryPattern =
  /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const gitSuffixPattern = /\.git$/u;
const sshRemotePattern = /^git@github\.com:(?<repository>[^\s]+?)(?:\.git)?$/u;

export type BrokeredS3Source = Readonly<{
  repository: string;
  checkout: string;
}>;

export const parseBrokeredSource = (raw: unknown): BrokeredS3Source | null => {
  if (
    !(
      isRecord(raw) &&
      Object.keys(raw).length === 2 &&
      typeof raw.repository === 'string' &&
      repositoryPattern.test(raw.repository) &&
      typeof raw.checkout === 'string' &&
      raw.checkout.trim() === raw.checkout &&
      raw.checkout.length > 0 &&
      !raw.checkout.includes('\\')
    )
  ) {
    return null;
  }
  return { repository: raw.repository, checkout: raw.checkout };
};

export const brokeredReferenceIdentity = (
  reference: BrokeredS3Reference,
): string =>
  `${reference.source === undefined ? '' : `${reference.source.repository}@`}${reference.brokeredS3}:${reference.key}`;

export const validBrokeredIdentity = (raw: string): boolean => {
  const separator = raw.indexOf('@');
  return separator === -1
    ? parseDestination(raw) !== null
    : repositoryPattern.test(raw.slice(0, separator)) &&
        parseDestination(raw.slice(separator + 1)) !== null;
};

const remoteRepository = (remote: string): string | null => {
  const ssh = sshRemotePattern.exec(remote)?.groups?.repository;
  if (ssh !== undefined) {
    return ssh;
  }
  try {
    const url = new URL(remote);
    if (
      url.hostname !== 'github.com' ||
      !['https:', 'ssh:'].includes(url.protocol) ||
      url.port !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return null;
    }
    return url.pathname.slice(1).replace(gitSuffixPattern, '');
  } catch {
    return null;
  }
};

type SourceResolution =
  | Readonly<{ ok: true; root: string; rel: string }>
  | Readonly<{ ok: false; problem: string }>;

export const resolveBrokeredSource = (
  consumer: string,
  reference: BrokeredS3Reference,
): SourceResolution => {
  let root = consumer;
  if (reference.source !== undefined) {
    try {
      root = resolve(consumer, reference.source.checkout);
      if (realpathSync(root) !== root) {
        return {
          ok: false,
          problem: 'source checkout must not contain symlinks',
        };
      }
      const git = (args: ReadonlyArray<string>) =>
        execFileSync('git', ['-C', root, ...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      if (git(['rev-parse', '--show-toplevel']) !== root) {
        return {
          ok: false,
          problem: 'source checkout must name a repository root',
        };
      }
      if (
        remoteRepository(git(['remote', 'get-url', 'origin'])) !==
        reference.source.repository
      ) {
        return {
          ok: false,
          problem:
            'source checkout origin does not match the authorized repository',
        };
      }
    } catch {
      return {
        ok: false,
        problem: 'source checkout is not an accessible Git repository',
      };
    }
  }
  const target = resolveTargetRelResult(root, reference.brokeredS3);
  return target.ok
    ? { ok: true, root, rel: target.rel }
    : {
        ok: false,
        problem:
          target.kind === 'ambiguous'
            ? target.problem
            : `secrets target "${reference.brokeredS3}" does not exist; create it and mint the pair with \`bun standards creds add cloudflare --s3\``,
      };
};
