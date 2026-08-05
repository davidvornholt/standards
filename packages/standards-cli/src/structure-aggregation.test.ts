import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { collectStructureProblems } from './structure-check';
import {
  buildConsumer,
  CI_SOPS_METADATA_YAML,
  cleanupStructureTmps,
  writeInto as write,
} from './structure-test-support';

afterEach(cleanupStructureTmps);

describe('root and CI secret validation aggregation', () => {
  it('reports a plaintext secret beside a malformed root manifest', async () => {
    const consumer = buildConsumer();
    write(consumer, 'package.json', '{ malformed');
    write(
      consumer,
      'secrets/ci.yaml',
      `ci:\n  ntfy_topic_url: PLAINTEXT_MUST_NOT_BE_ECHOED\n${CI_SOPS_METADATA_YAML}`,
    );
    const problems = await collectStructureProblems(consumer, 'consumer');
    expect(problems).toContain(
      'package.json must exist and contain a JSON object',
    );
    expect(problems).toContain(
      'secrets/ci.yaml: value at "ci.ntfy_topic_url" is not a complete SOPS-encrypted value; plaintext secret values must never be committed',
    );
    expect(problems.join('\n')).not.toContain('PLAINTEXT_MUST_NOT_BE_ECHOED');
  });

  it('reports malformed secrets beside a missing root manifest', async () => {
    const consumer = buildConsumer();
    rmSync(join(consumer, 'package.json'));
    write(consumer, 'secrets/ci.yaml', 'ci: [unclosed\n');
    const problems = await collectStructureProblems(consumer, 'consumer');
    expect(problems).toContain(
      'package.json must exist and contain a JSON object',
    );
    expect(problems).toContain(
      'secrets/ci.yaml must contain valid YAML with unique mapping keys',
    );
  });

  it('reports missing secret files beside a missing root manifest', async () => {
    const consumer = buildConsumer();
    rmSync(join(consumer, 'package.json'));
    rmSync(join(consumer, 'secrets'), { recursive: true });
    expect(await collectStructureProblems(consumer, 'consumer')).toEqual([
      'package.json must exist and contain a JSON object',
      'secrets/ci.yaml: must exist as a SOPS-encrypted file; the synced CI workflows read ci.ntfy_topic_url and, when automatic sync is enabled, ci.broker_app from it',
      'secrets/ci.example.yaml: must exist and mirror the key shape of secrets/ci.yaml with plaintext placeholders',
    ]);
  });
});
