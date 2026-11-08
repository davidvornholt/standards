// The trusted settings checker must not read pins from the pull request
// checkout, so its install step carries a copy of the Bun archive pins inline.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTUAL_UPSTREAM, yamlRunScript } from './cli-test-support';

type BunArchive = {
  readonly asset: string;
  readonly assetId: number;
  readonly sha256: string;
};

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(join(ACTUAL_UPSTREAM, path), 'utf8'));

const archives = readJson('nix/bun-archives.json') as Record<
  string,
  Record<string, BunArchive>
>;
const { packageManager } = readJson('package.json') as {
  readonly packageManager: string;
};
const version = packageManager.replace(/^bun@/u, '');
const installRun = yamlRunScript(
  join(ACTUAL_UPSTREAM, '.github/workflows/standards.yml'),
  'Install pinned settings checker',
);

const PIN_LINE =
  /^ {2}(?<machine>\w+)\) bun_platform=(?<platform>[\w-]+); bun_asset=(?<assetId>\d+); bun_sha=(?<sha256>[a-f0-9]{64}) ;;$/gmu;

const inlinePins = (): Record<string, BunArchive> =>
  Object.fromEntries(
    [...installRun.matchAll(PIN_LINE)].map(({ groups = {} }) => [
      // The step matches `uname -m`, which on Linux is the Nix system name
      // without its `-linux` suffix.
      `${groups.machine}-linux`,
      {
        asset: `bun-linux-${groups.platform}.zip`,
        assetId: Number(groups.assetId),
        sha256: groups.sha256,
      },
    ]),
  );

describe('settings checker Bun pins', () => {
  it('install the Bun version the root packageManager pins', () => {
    expect(installRun).toContain(`bun_version=${version}\n`);
  });

  it('equal the archive table entry for that version on every system', () => {
    expect(inlinePins()).toEqual(archives[version]);
  });
});
