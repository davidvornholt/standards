import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findManagedFilesContainingBiomeDirectiveToken,
  listManagedFiles,
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
