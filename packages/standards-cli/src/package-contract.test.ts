import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'bun';

const packageRoot = join(import.meta.dir, '..');
const rootPackage = join(packageRoot, '../../package.json');
const templatePackage = join(packageRoot, '../../template/package.json');
const directories: Array<string> = [];
const DIRECTORY_RUNTIME_FILES = [
  'package/src/sync-directory-handles.ts',
  'package/src/sync-directory-traversal.ts',
] as const;
const PARENT_BINDING_RUNTIME_FILES = [
  'package/src/sync-transaction-parent-binding.ts',
  'package/src/sync-transaction-parent-cleanup.ts',
  'package/src/sync-transaction-parent-missing.ts',
  'package/src/sync-transaction-parent-open.ts',
] as const;
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

const run = (command: ReadonlyArray<string>) => {
  const result = spawnSync([...command], { cwd: packageRoot });
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
    expect(listing.output.trim().split('\n')).toEqual([
      'package/package.json',
      'package/LICENSE',
      'package/README.md',
      'package/src/cli.ts',
      'package/src/github-api.ts',
      'package/src/github-apply.ts',
      'package/src/github-commands.ts',
      'package/src/github-custom-protection-response.ts',
      'package/src/github-default-branch-apply.ts',
      'package/src/github-default-branch-response.ts',
      'package/src/github-default-branch-settings.ts',
      'package/src/github-default-branch.ts',
      'package/src/github-diff.ts',
      'package/src/github-environment-apply.ts',
      'package/src/github-environment-response.ts',
      'package/src/github-environment-settings.ts',
      'package/src/github-environments.ts',
      'package/src/github-live-state.ts',
      'package/src/github-ruleset-rule-settings.ts',
      'package/src/github-ruleset-settings.ts',
      'package/src/github-rulesets.ts',
      'package/src/github-settings-merge.ts',
      'package/src/github-settings.ts',
      'package/src/sync-descriptor-write.ts',
      ...DIRECTORY_RUNTIME_FILES,
      'package/src/sync-filesystem.ts',
      'package/src/sync-linux-rename.ts',
      'package/src/sync-mount-identity.ts',
      'package/src/sync-mutation-hooks.ts',
      'package/src/sync-mutation-lifecycle.ts',
      'package/src/sync-mutations.ts',
      'package/src/sync-policy.ts',
      'package/src/sync-source.ts',
      'package/src/sync-transaction-artifact-cleanup.ts',
      'package/src/sync-transaction-artifact-names.ts',
      'package/src/sync-transaction-artifact-validation.ts',
      'package/src/sync-transaction-atomic-record.ts',
      'package/src/sync-transaction-atomic-recovery.ts',
      'package/src/sync-transaction-backup.ts',
      'package/src/sync-transaction-build.ts',
      'package/src/sync-transaction-cleanup-state.ts',
      'package/src/sync-transaction-cleanup.ts',
      'package/src/sync-transaction-commit.ts',
      'package/src/sync-transaction-durable-cleanup.ts',
      'package/src/sync-transaction-failure.ts',
      'package/src/sync-transaction-files.ts',
      'package/src/sync-transaction-journal-parser.ts',
      'package/src/sync-transaction-journal.ts',
      'package/src/sync-transaction-owner-reservation.ts',
      'package/src/sync-transaction-ownership.ts',
      ...PARENT_BINDING_RUNTIME_FILES,
      'package/src/sync-transaction-parent-removal.ts',
      'package/src/sync-transaction-parent-reservation.ts',
      'package/src/sync-transaction-parent-state.ts',
      'package/src/sync-transaction-parents.ts',
      'package/src/sync-transaction-plan.ts',
      'package/src/sync-transaction-prepare.ts',
      'package/src/sync-transaction-publication-cases.ts',
      'package/src/sync-transaction-publication-namespace.ts',
      'package/src/sync-transaction-publication-recovery.ts',
      'package/src/sync-transaction-publication.ts',
      'package/src/sync-transaction-recovery-state.ts',
      'package/src/sync-transaction-recovery.ts',
      'package/src/sync-transaction-reservation-record.ts',
      'package/src/sync-transaction-reservation.ts',
      'package/src/sync-transaction-rollback-operation.ts',
      'package/src/sync-transaction-rollback.ts',
      'package/src/sync-transaction-types.ts',
      'package/src/sync-transaction-verification.ts',
    ]);
    const packed = readPackedManifest(artifact);
    expect(packed.exitCode).toBe(0);
    expect(packed.manifest.dependencies).toBeUndefined();
    expect(packed.manifest.exports).toEqual({});
    expect(packed.manifest.files).toContain('SOURCE_COMMIT');
    expect(packed.manifest.os).toEqual(['linux']);
    expect(packed.manifest.scripts).not.toHaveProperty('release:state');
  });
});
