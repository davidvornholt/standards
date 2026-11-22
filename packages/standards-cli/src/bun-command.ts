import { join, resolve } from 'node:path';
import process from 'node:process';
import { dockerHubDigestResolver } from './bun-docker-hub';
import {
  type ImageDigestResolver,
  raiseBunPins,
  readBunVersion,
} from './bun-pins';
import { COOLDOWN_DAYS, runBunUpgrade, type UpgradeHttp } from './bun-upgrade';
import { resolveToken } from './github-api';

const USAGE = `Usage: standards bun upgrade [--write] [--dir <path>]

  upgrade   In the standards source repository, find the newest stable Bun
            release that has been out for ${COOLDOWN_DAYS} days, verify its
            archives, and with --write raise every Bun pin to it.`;

const TIMEOUT_MS = 120_000;

const checked = async (url: string, init: RequestInit): Promise<Response> => {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GET ${url}: HTTP ${response.status}`);
  }
  return response;
};

// The release list reads with a token where one is available, because the
// anonymous API limit is low on shared CI runners.
const liveHttp = (): UpgradeHttp => {
  const token = resolveToken();
  return {
    json: async (url) =>
      (await checked(url, {
        headers: {
          accept: 'application/vnd.github+json',
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
      }).then((response) => response.json())) as unknown,
    bytes: async (url) =>
      new Uint8Array(await (await checked(url, {})).arrayBuffer()),
  };
};

const runUpgrade = async (argv: ReadonlyArray<string>): Promise<boolean> => {
  let dir = process.cwd();
  let write = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write') {
      write = true;
    } else if (arg === '--dir' && argv[index + 1] !== undefined) {
      dir = argv[index + 1] ?? dir;
      index += 1;
    } else {
      console.error(
        `standards bun upgrade: unknown argument ${arg}\n\n${USAGE}`,
      );
      return false;
    }
  }
  const { current, next } = await runBunUpgrade({
    dir: resolve(dir),
    now: new Date(),
    http: liveHttp(),
    write,
  });
  if (next === null) {
    console.log(
      `standards bun: Bun ${current} is current; no newer stable release has been out for ${COOLDOWN_DAYS} days`,
    );
  } else if (write) {
    console.log(
      `standards bun: upgraded Bun from ${current} to ${next}; the GitHub digest, SHASUMS256.txt, and download of each pinned archive agree`,
    );
  } else {
    console.log(
      `standards bun: Bun ${next} has been out for ${COOLDOWN_DAYS} days and its pinned archives verify; run with --write to upgrade from ${current}`,
    );
  }
  return true;
};

export const runBunCommand = (
  argv: ReadonlyArray<string>,
): Promise<boolean> => {
  const [subcommand, ...rest] = argv;
  if (subcommand === 'upgrade') {
    return runUpgrade(rest);
  }
  if (
    subcommand === undefined ||
    subcommand === '--help' ||
    subcommand === '-h'
  ) {
    console.log(USAGE);
    return Promise.resolve(subcommand !== undefined);
  }
  console.error(`standards bun: unknown subcommand ${subcommand}\n\n${USAGE}`);
  return Promise.resolve(false);
};

// After a sync, raises the consumer's Bun pins to the Bun the synced standards
// commit runs, whose archives the synced nix/bun-archives.json lists. A dry run
// reports the raise without resolving image digests.
export const raiseSyncedBunPins = async ({
  consumer,
  sourceDir,
  managed,
  dryRun,
  resolveDigest = dockerHubDigestResolver(),
}: {
  readonly consumer: string;
  readonly sourceDir: string;
  readonly managed: ReadonlyArray<string>;
  readonly dryRun: boolean;
  readonly resolveDigest?: ImageDigestResolver;
}): Promise<void> => {
  const target = await readBunVersion(join(sourceDir, 'package.json'));
  if (target === null) {
    return;
  }
  // A registry outage must not block the sync itself. The raise resolves every
  // digest before it writes, so a failure leaves every pin as it was, and the
  // next sync tries again.
  const result = await raiseBunPins({
    dir: consumer,
    target,
    exclude: new Set(managed),
    resolveDigest: dryRun ? null : resolveDigest,
  }).catch((error: unknown) => {
    console.warn(
      `  left Bun pins as they are, because raising them to ${target} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (result === undefined) {
    return;
  }
  if (result === null) {
    console.log(
      `  left Bun pins as they are: ${consumer} isn't a git checkout, so sync can't list its files`,
    );
    return;
  }
  for (const { path, from } of result.raised) {
    console.log(
      `  ${dryRun ? 'would raise' : 'raised'} Bun ${from.join(', ')} to ${target} in ${path}`,
    );
  }
  for (const note of result.kept) {
    console.log(
      `  ${dryRun ? 'would leave' : 'left'} a digest-pinned image below Bun ${target} outside Docker Hub, raise it by hand: ${note}`,
    );
  }
};
