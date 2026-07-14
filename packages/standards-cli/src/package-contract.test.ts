import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'bun';

const packageRoot = join(import.meta.dir, '..');
const templatePackage = join(packageRoot, '../../template/package.json');
const directories: Array<string> = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const run = (command: ReadonlyArray<string>) => {
  const result = spawnSync([...command], { cwd: packageRoot });
  return {
    exitCode: result.exitCode,
    output: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

describe('published package contract', () => {
  it('matches the exact CLI version seeded for new consumers', () => {
    const publicManifest = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8'),
    ) as { readonly name: string; readonly version: string };
    const templateManifest = JSON.parse(
      readFileSync(templatePackage, 'utf8'),
    ) as {
      readonly devDependencies: Readonly<Record<string, string>>;
    };
    expect(templateManifest.devDependencies[publicManifest.name]).toBe(
      publicManifest.version,
    );
    expect(
      JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')),
    ).toHaveProperty('exports', {});
  });

  it('packs only the zero-dependency public CLI', () => {
    const directory = mkdtempSync(join(tmpdir(), 'standards-package-'));
    directories.push(directory);
    const pack = run([
      'bun',
      'pm',
      'pack',
      '--destination',
      directory,
      '--ignore-scripts',
    ]);
    expect(pack).toMatchObject({ exitCode: 0, stderr: '' });
    const artifacts = readdirSync(directory).filter((file) =>
      file.endsWith('.tgz'),
    );
    expect(artifacts).toHaveLength(1);
    const artifact = join(directory, artifacts[0] ?? 'missing');
    const listing = run(['tar', '-tzf', artifact]);
    expect(listing.exitCode).toBe(0);
    const entries = listing.output.trim().split('\n');
    expect(entries).toEqual([
      'package/package.json',
      'package/LICENSE',
      'package/README.md',
      'package/src/cli.ts',
      'package/src/github-api.ts',
      'package/src/github-apply.ts',
      'package/src/github-commands.ts',
      'package/src/github-diff.ts',
      'package/src/github-environment-apply.ts',
      'package/src/github-environment-response.ts',
      'package/src/github-environment-settings.ts',
      'package/src/github-environments.ts',
      'package/src/github-settings.ts',
      'package/src/sync-policy.ts',
      'package/src/sync-source.ts',
    ]);
    const manifestArchive = run([
      'tar',
      '-xOzf',
      artifact,
      'package/package.json',
    ]);
    expect(manifestArchive.exitCode).toBe(0);
    const manifest = JSON.parse(manifestArchive.output) as {
      readonly dependencies?: unknown;
      readonly exports?: unknown;
      readonly files?: ReadonlyArray<string>;
      readonly scripts?: Readonly<Record<string, string>>;
    };
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.exports).toEqual({});
    expect(manifest.files).toContain('SOURCE_COMMIT');
    expect(manifest.scripts).not.toHaveProperty('release:state');
  });
});
