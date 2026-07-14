import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { YAML: BunYaml } = await import('bun');

const WORKFLOW = join(
  import.meta.dir,
  '../../../.github/workflows/standards.yml',
);

describe('canonical quality workflow permissions', () => {
  it('grants only the reads required by the GitHub settings gate', () => {
    const workflow = BunYaml.parse(readFileSync(WORKFLOW, 'utf8')) as {
      readonly permissions?: unknown;
    };

    expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' });
  });
});
