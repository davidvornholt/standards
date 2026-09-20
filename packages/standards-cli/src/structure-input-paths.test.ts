import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { collectStructureProblems } from './structure-check';
import { collectCiSecretsProblems } from './structure-secrets';
import {
  buildConsumer,
  cleanupStructureTmps,
  consumerRootManifest,
  newStructureTmp,
  writeInto as write,
  writeCiSecretsPair,
} from './structure-test-support';

afterEach(cleanupStructureTmps);

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

  it.each(['apps/web', 'apps/web/package.json'])(
    'rejects a symlinked workspace input: %s',
    async (rel) => {
      const external = buildConsumer();
      const consumer = buildConsumer(
        consumerRootManifest({ workspaces: ['apps/web', 'packages/ui'] }),
      );
      rmSync(join(consumer, rel), { recursive: true });
      symlinkSync(join(external, rel), join(consumer, rel));
      expect(await collectStructureProblems(consumer, 'consumer')).toEqual([
        'apps/web: package.json must be a contained regular file; symlinked paths are not allowed',
      ]);
    },
  );

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
