// Runs the upgrade against a copy of this repository's pinned files and a fake
// GitHub release, then checks the same invariants the real pins must keep.

import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBunUpgrade, type UpgradeHttp } from './bun-upgrade';
import {
  ACTUAL_UPSTREAM,
  cleanupTmpDirs,
  mkTmp,
  write,
  yamlRunScript,
} from './cli-test-support';

const PINNED_FILES = [
  'package.json',
  'template/package.json',
  'packages/standards-cli/package.json',
  'nix/bun-archives.json',
  '.github/workflows/standards.yml',
  '.github/workflows/standards-sync.yml',
  '.github/workflows/publish-standards-cli.yml',
  'packages/standards-cli/src/fixtures/trusted-settings-steps.json',
];

const read = (dir: string, path: string): string =>
  readFileSync(join(dir, path), 'utf8');

const current = (
  JSON.parse(read(ACTUAL_UPSTREAM, 'package.json')) as {
    readonly packageManager: string;
  }
).packageManager.replace(/^bun@/u, '');
const [major, minor, patch] = current.split('.').map(Number);
const NEXT = `${major}.${minor}.${(patch ?? 0) + 1}`;
const NOW = new Date('2026-11-22T00:00:00Z');
const DAY_MS = 86_400_000;
const ASSETS = ['bun-linux-aarch64.zip', 'bun-linux-x64-baseline.zip'];

const repo = (): string => {
  const dir = mkTmp('bun-upgrade-');
  execFileSync('git', ['init', '--quiet', dir]);
  for (const path of PINNED_FILES) {
    write(dir, path, read(ACTUAL_UPSTREAM, path));
  }
  execFileSync('git', ['add', '--all'], { cwd: dir });
  return dir;
};

const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

type FakeRelease = {
  readonly version: string;
  readonly publishedDaysAgo: number;
  readonly prerelease?: boolean;
  // Overrides of what SHASUMS256.txt lists, by asset name.
  readonly listed?: Readonly<Record<string, string>>;
};

const archiveBytes = (version: string, name: string): Uint8Array =>
  new TextEncoder().encode(`${version} ${name}`);

const fakeHttp = (releases: ReadonlyArray<FakeRelease>): UpgradeHttp => {
  const downloads = new Map<string, Uint8Array>();
  const raw = releases.map((release, index) => {
    const base = `https://github.com/oven-sh/bun/releases/download/bun-v${release.version}/`;
    const sums = ASSETS.map((name) => {
      const bytes = archiveBytes(release.version, name);
      downloads.set(`${base}${name}`, bytes);
      return `${release.listed?.[name] ?? sha256(bytes)}  ${name}`;
    }).join('\n');
    const sumsBytes = new TextEncoder().encode(`${sums}\n`);
    downloads.set(`${base}SHASUMS256.txt`, sumsBytes);
    const asset = (name: string, id: number, bytes: Uint8Array) => ({
      name,
      id,
      digest: `sha256:${sha256(bytes)}`,
      // biome-ignore lint/style/useNamingConvention: GitHub API field
      browser_download_url: `${base}${name}`,
    });
    return {
      // biome-ignore lint/style/useNamingConvention: GitHub API field
      tag_name: `bun-v${release.version}`,
      draft: false,
      prerelease: release.prerelease ?? false,
      // biome-ignore lint/style/useNamingConvention: GitHub API field
      published_at: new Date(
        NOW.getTime() - release.publishedDaysAgo * DAY_MS,
      ).toISOString(),
      assets: [
        asset('SHASUMS256.txt', 1000 * index + 1, sumsBytes),
        ...ASSETS.map((name, offset) =>
          asset(
            name,
            1000 * index + offset + 2,
            archiveBytes(release.version, name),
          ),
        ),
      ],
    };
  });
  return {
    json: () => Promise.resolve(raw),
    bytes: (url) => {
      const bytes = downloads.get(url);
      return bytes === undefined
        ? Promise.reject(new Error(`unexpected download ${url}`))
        : Promise.resolve(bytes);
    },
  };
};

const resolveDigest = (tag: string): Promise<string> =>
  Promise.resolve(`sha256:${createHash('sha256').update(tag).digest('hex')}`);

const upgrade = (
  dir: string,
  releases: ReadonlyArray<FakeRelease>,
  writes = true,
) =>
  runBunUpgrade({
    dir,
    now: NOW,
    http: fakeHttp(releases),
    resolveDigest,
    write: writes,
  });

const snapshot = (dir: string): ReadonlyArray<string> =>
  PINNED_FILES.map((path) => read(dir, path));

afterEach(cleanupTmpDirs);

// The newest release is still in its cooldown, and the newer minor is a
// prerelease, so the upgrade picks NEXT.
const RELEASES: ReadonlyArray<FakeRelease> = [
  { version: NEXT, publishedDaysAgo: 3 },
  { version: `${major}.${minor}.${(patch ?? 0) + 2}`, publishedDaysAgo: 2 },
  {
    version: `${major}.${(minor ?? 0) + 1}.0`,
    publishedDaysAgo: 5,
    prerelease: true,
  },
];

describe('runBunUpgrade with an upgrade', () => {
  it('verifies the archives of the newest release past the cooldown', async () => {
    const dir = repo();
    const result = await upgrade(dir, RELEASES);

    expect(result).toEqual({ current, next: NEXT });
    const table = JSON.parse(read(dir, 'nix/bun-archives.json')) as Record<
      string,
      Record<string, { asset: string; assetId: number; sha256: string }>
    >;
    expect(Object.keys(table)).toEqual([current, NEXT]);
    expect(table[NEXT]).toEqual({
      'aarch64-linux': {
        asset: 'bun-linux-aarch64.zip',
        assetId: 2,
        sha256: sha256(archiveBytes(NEXT, 'bun-linux-aarch64.zip')),
      },
      'x86_64-linux': {
        asset: 'bun-linux-x64-baseline.zip',
        assetId: 3,
        sha256: sha256(archiveBytes(NEXT, 'bun-linux-x64-baseline.zip')),
      },
    });
    const install = yamlRunScript(
      join(dir, '.github/workflows/standards.yml'),
      'Install pinned settings checker',
    );
    expect(install).toContain(`bun_version=${NEXT}\n`);
    expect(install).toContain(
      `aarch64) bun_platform=aarch64; bun_asset=2; bun_sha=${table[NEXT]?.['aarch64-linux']?.sha256} ;;`,
    );
    expect(install).toContain(
      `x86_64) bun_platform=x64-baseline; bun_asset=3; bun_sha=${table[NEXT]?.['x86_64-linux']?.sha256} ;;`,
    );
    const fixture = JSON.parse(
      read(
        dir,
        'packages/standards-cli/src/fixtures/trusted-settings-steps.json',
      ),
    ) as ReadonlyArray<{ readonly name: string; readonly run?: string }>;
    expect(
      fixture
        .find(({ name }) => name === 'Install pinned settings checker')
        ?.run?.trimEnd(),
    ).toBe(install.trimEnd());
  });

  it('raises every other Bun pin to that release', async () => {
    const dir = repo();
    await upgrade(dir, RELEASES);

    expect(read(dir, '.github/workflows/standards-sync.yml')).toContain(
      `|| '${NEXT}' }}`,
    );
    expect(read(dir, '.github/workflows/publish-standards-cli.yml')).toContain(
      `BUN_VERSION: ${NEXT}\n`,
    );
    for (const manifest of ['package.json', 'template/package.json']) {
      expect(read(dir, manifest)).toContain(`"packageManager": "bun@${NEXT}"`);
    }
    expect(read(dir, 'packages/standards-cli/package.json')).toContain(
      `"bun": ">=${NEXT}"`,
    );
    const stale = new RegExp(
      String.raw`(?:bun@|bun_version=|BUN_VERSION: |>=|')${current.replaceAll('.', String.raw`\.`)}\b`,
      'u',
    );
    for (const path of PINNED_FILES.filter(
      (file) => file !== 'nix/bun-archives.json',
    )) {
      expect(read(dir, path)).not.toMatch(stale);
    }
  });
});

describe('runBunUpgrade without an upgrade', () => {
  it('waits out the cooldown and skips prereleases', async () => {
    const dir = repo();
    const before = snapshot(dir);

    expect(
      await upgrade(dir, [
        { version: NEXT, publishedDaysAgo: 2.9 },
        {
          version: `${major}.${(minor ?? 0) + 1}.0`,
          publishedDaysAgo: 9,
          prerelease: true,
        },
      ]),
    ).toEqual({ current, next: null });
    expect(snapshot(dir)).toEqual(before);
  });

  it('reports without writing unless asked to write', async () => {
    const dir = repo();
    const before = snapshot(dir);

    expect(
      await upgrade(dir, [{ version: NEXT, publishedDaysAgo: 4 }], false),
    ).toEqual({ current, next: NEXT });
    expect(snapshot(dir)).toEqual(before);
  });

  it('refuses an archive whose hashes disagree and writes nothing', async () => {
    const dir = repo();
    const before = snapshot(dir);

    await expect(
      upgrade(dir, [
        {
          version: NEXT,
          publishedDaysAgo: 4,
          listed: { 'bun-linux-aarch64.zip': '0'.repeat(64) },
        },
      ]),
    ).rejects.toThrow(
      `The SHA-256 of Bun ${NEXT} bun-linux-aarch64.zip disagrees`,
    );
    expect(snapshot(dir)).toEqual(before);
  });
});
