import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLI = readFileSync(join(import.meta.dir, 'cli.ts'), 'utf8');
const SOURCE_SELECTION_CALL = /\bselectSourceTrees\(/gu;

it('routes both init and sync through the production source owner', () => {
  expect(CLI.match(SOURCE_SELECTION_CALL)).toHaveLength(2);
  expect(CLI).not.toContain('snapshotRepositoryTreeSets');
  expect(CLI).not.toContain('afterManifestLoad');
});
