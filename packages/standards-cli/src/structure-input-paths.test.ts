import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { collectWorkspaceReadmeProblems } from './structure-readme';
import { collectCiSecretsProblems } from './structure-secrets';
import {
  cleanupStructureTmps,
  newStructureTmp,
  writeInto as write,
  writeCiSecretsPair,
} from './structure-test-support';

afterEach(cleanupStructureTmps);

const buildReadmeRepo = (): string => {
  const dir = newStructureTmp('structure-paths-');
  write(dir, 'sync-standards.json', JSON.stringify({ paths: [] }));
  write(dir, 'apps/web/README.md', '# web\n');
  return dir;
};

describe('contained structure inputs', () => {
  it.each(['ci.yaml', 'ci.example.yaml'])(
    'rejects a symlinked secrets/%s leaf even when its target is valid',
    async (file) => {
      const external = newStructureTmp('structure-paths-external-');
      const consumer = newStructureTmp('structure-paths-consumer-');
      writeCiSecretsPair(external);
      writeCiSecretsPair(consumer);
      rmSync(join(consumer, 'secrets', file));
      symlinkSync(
        join(external, 'secrets', file),
        join(consumer, 'secrets', file),
      );
      expect(await collectCiSecretsProblems(consumer)).toContain(
        `secrets/${file}: must be a contained regular file; symlinked paths are not allowed`,
      );
    },
  );

  it('rejects a symlinked secrets ancestor with valid external files', async () => {
    const external = newStructureTmp('structure-paths-external-');
    const consumer = newStructureTmp('structure-paths-consumer-');
    writeCiSecretsPair(external);
    symlinkSync(join(external, 'secrets'), join(consumer, 'secrets'));
    expect(await collectCiSecretsProblems(consumer)).toEqual([
      'secrets/ci.yaml: must be a contained regular file; symlinked paths are not allowed',
      'secrets/ci.example.yaml: must be a contained regular file; symlinked paths are not allowed',
    ]);
  });

  it('rejects a symlinked workspace with a valid external README', async () => {
    const external = newStructureTmp('structure-paths-external-');
    const consumer = newStructureTmp('structure-paths-consumer-');
    write(external, 'README.md', '# external\n');
    write(consumer, 'sync-standards.json', JSON.stringify({ paths: [] }));
    mkdirSync(join(consumer, 'apps'));
    symlinkSync(external, join(consumer, 'apps/web'));
    expect(
      await collectWorkspaceReadmeProblems(consumer, 'consumer', ['apps/web']),
    ).toEqual([
      'apps/web: README.md must be a contained regular file; symlinked paths are not allowed',
    ]);
  });

  it('rejects a symlinked README leaf with valid external content', async () => {
    const external = newStructureTmp('structure-paths-external-');
    const consumer = buildReadmeRepo();
    write(external, 'README.md', '# external\n');
    rmSync(join(consumer, 'apps/web/README.md'));
    symlinkSync(
      join(external, 'README.md'),
      join(consumer, 'apps/web/README.md'),
    );
    expect(
      await collectWorkspaceReadmeProblems(consumer, 'consumer', ['apps/web']),
    ).toEqual([
      'apps/web: README.md must be a contained regular file; symlinked paths are not allowed',
    ]);
  });

  it('rejects a symlinked sync manifest with valid external JSON', async () => {
    const external = newStructureTmp('structure-paths-external-');
    const consumer = buildReadmeRepo();
    write(external, 'sync-standards.json', JSON.stringify({ paths: [] }));
    rmSync(join(consumer, 'sync-standards.json'));
    symlinkSync(
      join(external, 'sync-standards.json'),
      join(consumer, 'sync-standards.json'),
    );
    expect(
      await collectWorkspaceReadmeProblems(consumer, 'consumer', ['apps/web']),
    ).toEqual([
      'sync-standards.json: must be a contained regular file; symlinked paths are not allowed',
    ]);
  });

  it('rejects a symlinked consumer root as a manifest ancestor', async () => {
    const actual = buildReadmeRepo();
    const parent = newStructureTmp('structure-paths-parent-');
    const consumer = join(parent, 'consumer');
    symlinkSync(actual, consumer);
    expect(
      await collectWorkspaceReadmeProblems(consumer, 'consumer', ['apps/web']),
    ).toEqual([
      'sync-standards.json: must be a contained regular file; symlinked paths are not allowed',
    ]);
  });

  it('does not let a symlinked sync policy disable credential checks', async () => {
    const external = newStructureTmp('structure-paths-external-');
    const consumer = newStructureTmp('structure-paths-consumer-');
    writeCiSecretsPair(consumer);
    write(external, 'policy.json', JSON.stringify({ autoSync: false }));
    symlinkSync(
      join(external, 'policy.json'),
      join(consumer, 'sync-standards.local.json'),
    );
    expect(await collectCiSecretsProblems(consumer)).toContain(
      'sync-standards.local.json must be a contained regular file; symlinked paths are not allowed',
    );
  });
});
