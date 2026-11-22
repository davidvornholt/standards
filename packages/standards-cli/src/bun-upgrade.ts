// Upgrades the standards source repository to the newest stable Bun release
// that has been out for the release cooldown. It verifies each pinned archive
// the way a person would before trusting it: the GitHub asset digest, the
// release's SHASUMS256.txt, and the downloaded bytes must agree. Then it
// writes the archive table, the inline pins of the trusted settings checker
// and its test fixture, the sync workflow's fallback, and every other Bun pin.

import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { dockerHubDigestResolver } from './bun-docker-hub';
import { type ImageDigestResolver, planBunPins, writeFiles } from './bun-pins';
import {
  compareVersions,
  isStableVersion,
  readBunVersion,
} from './bun-version';
import { isRecord } from './github-settings-parse';

// The same cooldown Dependabot applies to every other dependency.
export const COOLDOWN_DAYS = 3;
const DAY_MS = 86_400_000;
const RELEASES_URL =
  'https://api.github.com/repos/oven-sh/bun/releases?per_page=100';
const DOWNLOAD_PREFIX = 'https://github.com/oven-sh/bun/releases/download/';
const TAG_PREFIX = 'bun-v';
const SHASUMS = 'SHASUMS256.txt';
const SHA256 = /^[0-9a-f]{64}$/u;
const SHASUM_LINE = /^(?<sha>[0-9a-f]{64}) [ *](?<name>\S+)$/gmu;

export const ARCHIVES_FILE = 'nix/bun-archives.json';
const SETTINGS_CHECKER_FILES = [
  { file: '.github/workflows/standards.yml', newline: '\n' },
  {
    file: 'packages/standards-cli/src/fixtures/trusted-settings-steps.json',
    newline: '\\n',
  },
];
const SYNC_WORKFLOW = '.github/workflows/standards-sync.yml';

type Archive = {
  readonly asset: string;
  readonly assetId: number;
  readonly sha256: string;
};
type ArchiveTable = Readonly<Record<string, Readonly<Record<string, Archive>>>>;

type ReleaseAsset = {
  readonly id: number;
  readonly digest: string | null;
  readonly url: string;
};
type Release = {
  readonly version: string;
  readonly assets: ReadonlyMap<string, ReleaseAsset>;
};

export type UpgradeHttp = {
  readonly json: (url: string) => Promise<unknown>;
  readonly bytes: (url: string) => Promise<Uint8Array>;
};

const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const parseAsset = (
  raw: unknown,
): ReadonlyArray<readonly [string, ReleaseAsset]> => {
  if (
    !isRecord(raw) ||
    typeof raw.name !== 'string' ||
    typeof raw.id !== 'number' ||
    typeof raw.browser_download_url !== 'string'
  ) {
    return [];
  }
  const digest =
    typeof raw.digest === 'string' && raw.digest.startsWith('sha256:')
      ? raw.digest.slice('sha256:'.length)
      : null;
  return [[raw.name, { id: raw.id, digest, url: raw.browser_download_url }]];
};

// Stable releases published at least the cooldown before `now`.
export const eligibleReleases = (
  raw: unknown,
  now: Date,
): ReadonlyArray<Release> => {
  if (!Array.isArray(raw)) {
    throw new Error('GitHub returned no list of Bun releases');
  }
  const cutoff = now.getTime() - COOLDOWN_DAYS * DAY_MS;
  return raw.flatMap((release: unknown) => {
    if (
      !isRecord(release) ||
      release.draft !== false ||
      release.prerelease !== false ||
      typeof release.tag_name !== 'string' ||
      typeof release.published_at !== 'string' ||
      !release.tag_name.startsWith(TAG_PREFIX)
    ) {
      return [];
    }
    const version = release.tag_name.slice(TAG_PREFIX.length);
    const published = Date.parse(release.published_at);
    if (!(isStableVersion(version) && published <= cutoff)) {
      return [];
    }
    const assets = Array.isArray(release.assets) ? release.assets : [];
    return [{ version, assets: new Map(assets.flatMap(parseAsset)) }];
  });
};

const newest = (
  releases: ReadonlyArray<Release>,
  current: string,
): Release | null =>
  releases
    .filter(({ version }) => compareVersions(version, current) > 0)
    .reduce<Release | null>(
      (best, release) =>
        best === null || compareVersions(release.version, best.version) > 0
          ? release
          : best,
      null,
    );

const releaseAsset = (release: Release, name: string): ReleaseAsset => {
  const asset = release.assets.get(name);
  if (asset === undefined) {
    throw new Error(`Bun ${release.version} has no release asset ${name}`);
  }
  const expected = `${DOWNLOAD_PREFIX}${TAG_PREFIX}${release.version}/${name}`;
  if (asset.url !== expected) {
    throw new Error(
      `Bun ${release.version} serves ${name} from ${asset.url}, not ${expected}`,
    );
  }
  return asset;
};

const shasums = (text: string): ReadonlyMap<string, string> =>
  new Map(
    [...text.matchAll(SHASUM_LINE)].map(({ groups = {} }) => [
      groups.name ?? '',
      groups.sha ?? '',
    ]),
  );

// One verified archive per system the current version pins, under the same
// asset name.
const verifiedArchives = async (
  release: Release,
  pinned: Readonly<Record<string, Archive>>,
  http: UpgradeHttp,
): Promise<Record<string, Archive>> => {
  const sums = shasums(
    new TextDecoder().decode(
      await http.bytes(releaseAsset(release, SHASUMS).url),
    ),
  );
  const entries = await Promise.all(
    Object.entries(pinned).map(async ([system, { asset: name }]) => {
      const asset = releaseAsset(release, name);
      const downloaded = sha256(await http.bytes(asset.url));
      const listed = sums.get(name);
      if (asset.digest === null || !SHA256.test(asset.digest)) {
        throw new Error(`GitHub lists no SHA-256 digest for ${name}`);
      }
      if (asset.digest !== downloaded || listed !== downloaded) {
        throw new Error(
          `The SHA-256 of Bun ${release.version} ${name} disagrees: GitHub digest ${asset.digest}, ${SHASUMS} ${listed ?? 'missing'}, download ${downloaded}`,
        );
      }
      return [
        system,
        { asset: name, assetId: asset.id, sha256: downloaded },
      ] as const;
    }),
  );
  return Object.fromEntries(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  );
};

const replaceOnce = (
  text: string,
  file: string,
  before: string,
  after: string,
): string => {
  const parts = text.split(before);
  if (parts.length !== 2) {
    throw new Error(
      `${file} must contain ${JSON.stringify(before)} exactly once, but it appears ${parts.length - 1} times`,
    );
  }
  return parts.join(after);
};

const editedFile = async (
  dir: string,
  file: string,
  edit: (text: string) => string,
): Promise<readonly [string, string]> => [
  file,
  edit(await readFile(join(dir, file), 'utf8')),
];

// The checker step selects the archive by `uname -m`, the Nix system name
// without its `-linux` suffix, so each pinned system has one line that names
// its asset ID and hash. The fixture holds the same script as a JSON string,
// where a line ends in the two characters `\n`.
const settingsCheckerEdit = (
  { file, newline }: { readonly file: string; readonly newline: string },
  versions: { readonly current: string; readonly next: string },
  pinned: Readonly<Record<string, Archive>>,
  upgraded: Readonly<Record<string, Archive>>,
): ((text: string) => string) => {
  const line = (archive: Archive | undefined): string =>
    `bun_asset=${archive?.assetId}; bun_sha=${archive?.sha256} ;;`;
  return (text) =>
    Object.entries(pinned).reduce(
      (edited, [system, archive]) =>
        replaceOnce(edited, file, line(archive), line(upgraded[system])),
      replaceOnce(
        text,
        file,
        `bun_version=${versions.current}${newline}`,
        `bun_version=${versions.next}${newline}`,
      ),
    );
};

export type BunUpgradeResult = {
  readonly current: string;
  readonly next: string | null;
};

const readArchiveTable = async (dir: string): Promise<ArchiveTable> =>
  JSON.parse(await readFile(join(dir, ARCHIVES_FILE), 'utf8')) as ArchiveTable;

export const runBunUpgrade = async ({
  dir: given,
  now,
  http,
  resolveDigest = dockerHubDigestResolver(),
  write,
}: {
  readonly dir: string;
  readonly now: Date;
  readonly http: UpgradeHttp;
  readonly resolveDigest?: ImageDigestResolver;
  readonly write: boolean;
}): Promise<BunUpgradeResult> => {
  // The pin raise reads only files inside a real directory, so a symlinked
  // checkout is upgraded through its target.
  const dir = await realpath(given);
  const current = await readBunVersion(join(dir, 'package.json'));
  if (current === null) {
    throw new Error('package.json must pin an exact bun@x.y.z packageManager');
  }
  const table = await readArchiveTable(dir);
  const pinned = table[current];
  if (pinned === undefined) {
    throw new Error(`${ARCHIVES_FILE} lists no archives for Bun ${current}`);
  }
  const release = newest(
    eligibleReleases(await http.json(RELEASES_URL), now),
    current,
  );
  if (release === null) {
    return { current, next: null };
  }
  const next = release.version;
  const upgraded = await verifiedArchives(release, pinned, http);
  // Every edit and every image digest is settled before anything is written,
  // so a failure leaves the repository as it was. The table keeps the current
  // version, which consumers pin until their next sync raises them, and drops
  // older ones, which nothing pins any more.
  const edits = new Map([
    [
      ARCHIVES_FILE,
      `${JSON.stringify({ [current]: pinned, [next]: upgraded }, null, 2)}\n`,
    ],
    ...(await Promise.all([
      ...SETTINGS_CHECKER_FILES.map((checker) =>
        editedFile(
          dir,
          checker.file,
          settingsCheckerEdit(checker, { current, next }, pinned, upgraded),
        ),
      ),
      editedFile(dir, SYNC_WORKFLOW, (text) =>
        replaceOnce(
          text,
          SYNC_WORKFLOW,
          `|| '${current}' }}`,
          `|| '${next}' }}`,
        ),
      ),
    ])),
  ]);
  const pins = await planBunPins({
    dir,
    target: next,
    exclude: new Set([ARCHIVES_FILE]),
    resolveDigest,
    contents: edits,
  });
  if (pins === null) {
    throw new Error(`${dir} must be a git checkout to raise its Bun pins`);
  }
  if (!pins.writes.has('package.json')) {
    throw new Error(`The Bun pin raise left ${dir}/package.json at ${current}`);
  }
  if (pins.kept.length > 0) {
    throw new Error(
      `Some Bun images can't be raised to ${next}: ${pins.kept.join('; ')}`,
    );
  }
  if (write) {
    await writeFiles(dir, new Map([...edits, ...pins.writes]));
  }
  return { current, next };
};
