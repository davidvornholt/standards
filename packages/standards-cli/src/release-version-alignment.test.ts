import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSONC } from 'bun';
import { ACTUAL_UPSTREAM } from './cli-test-support';

type PublishedPackageManifest = {
  readonly version: string;
};

type TemplateManifest = {
  readonly devDependencies: Readonly<Record<string, string>>;
};

type BunLock = {
  readonly workspaces: Readonly<Record<string, { readonly version: string }>>;
};

const README_NIX_RELEASE_TAG =
  /url = "github:davidvornholt\/standards\/v(?<version>\d+\.\d+\.\d+)";/u;

const readJson = <T>(relativePath: string): T =>
  JSON.parse(readFileSync(join(ACTUAL_UPSTREAM, relativePath), 'utf8')) as T;

describe('standards CLI release version', () => {
  it('keeps the manifest, template pin, lock metadata, and README tag aligned', () => {
    const packageManifest = readJson<PublishedPackageManifest>(
      'packages/standards-cli/package.json',
    );
    const templateManifest = readJson<TemplateManifest>(
      'template/package.json',
    );
    const lock = JSONC.parse(
      readFileSync(join(ACTUAL_UPSTREAM, 'bun.lock'), 'utf8'),
    ) as BunLock;
    const readmeReleaseTag = readFileSync(
      join(ACTUAL_UPSTREAM, 'README.md'),
      'utf8',
    ).match(README_NIX_RELEASE_TAG)?.groups?.version;

    expect(templateManifest.devDependencies['@davidvornholt/standards']).toBe(
      packageManifest.version,
    );
    expect(lock.workspaces['packages/standards-cli'].version).toBe(
      packageManifest.version,
    );
    expect(readmeReleaseTag).toBe(packageManifest.version);
  });
});
