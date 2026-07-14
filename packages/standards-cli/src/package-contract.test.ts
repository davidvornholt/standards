import { afterEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'bun';
import { expectedPackedFiles } from './package-listing-test-fixture';

const packageRoot = join(import.meta.dir, '..');
const rootPackage = join(packageRoot, '../../package.json');
const templatePackage = join(packageRoot, '../../template/package.json');
const directories: Array<string> = [];
type PackedManifest = {
  readonly dependencies?: unknown;
  readonly exports?: unknown;
  readonly files?: ReadonlyArray<string>;
  readonly os?: ReadonlyArray<string>;
  readonly scripts?: Readonly<Record<string, string>>;
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const run = (command: ReadonlyArray<string>, cwd = packageRoot) => {
  const result = spawnSync([...command], { cwd });
  return {
    exitCode: result.exitCode,
    output: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

const readPackedManifest = (artifact: string) => {
  const archived = run(['tar', '-xOzf', artifact, 'package/package.json']);
  return {
    exitCode: archived.exitCode,
    manifest: JSON.parse(archived.output) as PackedManifest,
  };
};

it('declares Linux as the only supported package operating system', () => {
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, 'package.json'), 'utf8'),
  ) as { readonly os?: ReadonlyArray<string> };
  expect(manifest.os).toEqual(['linux']);
});

describe('published package contract', () => {
  it('matches the exact CLI version in source and seed roots', () => {
    const publicManifest = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8'),
    ) as { readonly name: string; readonly version: string };
    const rootManifest = JSON.parse(readFileSync(rootPackage, 'utf8')) as {
      readonly devDependencies: Readonly<Record<string, string>>;
    };
    const templateManifest = JSON.parse(
      readFileSync(templatePackage, 'utf8'),
    ) as {
      readonly devDependencies: Readonly<Record<string, string>>;
    };
    expect(rootManifest.devDependencies[publicManifest.name]).toBe(
      publicManifest.version,
    );
    expect(templateManifest.devDependencies[publicManifest.name]).toBe(
      publicManifest.version,
    );
    expect(
      JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')),
    ).toHaveProperty('exports', {});
  });
});

describe('packed package contract', () => {
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
    expect(listing.output.trim().split('\n')).toEqual([...expectedPackedFiles]);
    const packed = readPackedManifest(artifact);
    expect(packed.exitCode).toBe(0);
    expect(packed.manifest.dependencies).toBeUndefined();
    expect(packed.manifest.exports).toEqual({});
    expect(packed.manifest.files).toContain('SOURCE_COMMIT');
    expect(packed.manifest.os).toEqual(['linux']);
    expect(packed.manifest.scripts).not.toHaveProperty('release:state');
    const extracted = join(directory, 'extracted');
    mkdirSync(extracted);
    expect(run(['tar', '-xzf', artifact, '-C', extracted]).exitCode).toBe(0);
    const executed = run(
      ['bun', 'src/cli.ts', 'help'],
      join(extracted, 'package'),
    );
    expect(executed).toMatchObject({ exitCode: 0, stderr: '' });
    expect(executed.output).toContain('standards <command> [options]');
  });
});
