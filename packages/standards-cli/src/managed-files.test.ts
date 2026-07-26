import { describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findManagedFilesContainingBiomeDirectiveToken,
  listManagedFiles,
  writeManagedEntry,
} from './managed-files';

const repositoryRoot = join(import.meta.dir, '../../..');
const manifestPath = join(repositoryRoot, 'sync-standards.json');
const directiveToken = ['biome', 'ignore'].join('-');

const readCanonicalPaths = async (): Promise<ReadonlyArray<string>> => {
  const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('paths' in manifest) ||
    !Array.isArray(manifest.paths) ||
    !manifest.paths.every((path) => typeof path === 'string')
  ) {
    throw new Error('sync-standards.json must contain a string paths array');
  }
  return manifest.paths;
};

describe('managed file contract', () => {
  it('ships no raw Biome directive token in canonical synced files', async () => {
    const files = await listManagedFiles(
      repositoryRoot,
      await readCanonicalPaths(),
    );

    expect(files.size).toBeGreaterThan(0);
    expect(await findManagedFilesContainingBiomeDirectiveToken(files)).toEqual(
      [],
    );
  });

  it('uses sync ownership even when a seed ignore file hides a directory', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'managed-files-'));
    try {
      mkdirSync(join(fixtureRoot, 'template'), { recursive: true });
      writeFileSync(join(fixtureRoot, 'template/.gitignore'), 'fixtures/\n');
      mkdirSync(join(fixtureRoot, 'canonical/fixtures'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'canonical/fixtures/example.ts'),
        'export {};\n',
      );

      const files = await listManagedFiles(fixtureRoot, ['canonical']);

      expect([...files.keys()]).toEqual(['canonical/fixtures/example.ts']);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('finds the raw token without parsing language or comment syntax', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'managed-files-'));
    try {
      mkdirSync(join(fixtureRoot, 'canonical'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'canonical/documentation.txt'),
        `ordinary documentation containing ${directiveToken}`,
      );
      writeFileSync(
        join(fixtureRoot, 'canonical/clean.ts'),
        'export const clean = true;\n',
      );

      const files = await listManagedFiles(fixtureRoot, ['canonical']);

      expect(
        await findManagedFilesContainingBiomeDirectiveToken(files),
      ).toEqual(['canonical/documentation.txt']);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

describe('planting one managed entry', () => {
  // The module's own invariant, asserted directly because both call sites in
  // the CLI have already decided the question by the time they get here: one
  // proves the directory is engine-owned and removes it, the other returns
  // early. A caller that forgets must be stopped rather than silently allowed
  // to recurse through unbounded consumer content.
  it('refuses a directory destination instead of removing it recursively', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'managed-files-'));
    try {
      mkdirSync(join(fixtureRoot, 'dest/consumer'), { recursive: true });
      writeFileSync(join(fixtureRoot, 'dest/consumer/notes.md'), 'mine\n');
      writeFileSync(join(fixtureRoot, 'source.md'), 'canonical\n');

      const plant = writeManagedEntry(join(fixtureRoot, 'dest'), {
        kind: 'file',
        absolutePath: join(fixtureRoot, 'source.md'),
      });

      await expect(plant).rejects.toThrow('refusing to replace the directory');
      expect(
        readFileSync(join(fixtureRoot, 'dest/consumer/notes.md'), 'utf8'),
      ).toBe('mine\n');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('refuses to mirror a directory entry as a managed path', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'managed-files-'));
    try {
      const plant = writeManagedEntry(join(fixtureRoot, 'dest'), {
        kind: 'directory',
        absolutePath: join(fixtureRoot, 'source'),
      });

      await expect(plant).rejects.toThrow(
        'cannot mirror a directory as a managed path',
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
