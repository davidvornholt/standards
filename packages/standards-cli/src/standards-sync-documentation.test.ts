import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../../..');
const SYNC_SKILL = join(ROOT, '.agents/skills/standards-sync/SKILL.md');
const ROOT_README = join(ROOT, 'README.md');
const SEED_README = join(ROOT, 'template/README.md');
const PACKAGE_README = join(ROOT, 'packages/standards-cli/README.md');
const CURRENT_POLICY_DOCS = [
  ROOT_README,
  SEED_README,
  PACKAGE_README,
  SYNC_SKILL,
] as const;
const MIGRATION_DOCS = [ROOT_README, PACKAGE_README] as const;

describe('standards sync documentation', () => {
  it('documents the current policy and configured-ref recovery accurately', () => {
    for (const path of CURRENT_POLICY_DOCS) {
      const documentation = readFileSync(path, 'utf8');
      expect(documentation).toContain('@davidvornholt/standards` >=0.5.0');
      expect(documentation).toContain('exact direct development dependency');
      expect(documentation).toContain('checked-in');
      expect(documentation).toContain('explicit-ESM');
      expect(documentation).not.toContain('script wiring');
      expect(documentation).toContain('protected `standards-sync`');
      expect(documentation).toContain('repository dispatch');
      expect(documentation).toContain('syncPolicyContractVersion');
      expect(documentation).toContain(
        'repository-owned control seams `sync-standards.local.json`, `AGENTS.local.md`, `biome.jsonc`, or `.github/settings.local.json`',
      );
      expect(documentation).toContain('STANDARDS_SYNC_ENVIRONMENT_TOKEN');
      expect(documentation).toContain('classic branch protection');
      expect(documentation).toContain('ruleset-only');
      expect(documentation).toContain("repository's default branch");
      expect(documentation).not.toContain('protected-branch-only');
      expect(documentation).not.toContain('permits only branches protected');
    }
    expect(readFileSync(SYNC_SKILL, 'utf8')).toContain(
      'real sync from configured remote ref',
    );
  });

  it('keeps migration guidance out of the seed and routes the skill to it', () => {
    for (const path of MIGRATION_DOCS) {
      const documentation = readFileSync(path, 'utf8');
      expect(documentation).toContain('v0.4');
      expect(documentation).toContain(
        'bun add --dev --exact @davidvornholt/standards@0.5.0',
      );
      expect(documentation).toContain('legacy repository-level');
      expect(documentation).toContain('STANDARDS_SYNC_TOKEN');
      expect(documentation).toContain(
        "run a bare `bun standards sync` from the repository's default branch",
      );
      expect(documentation).toContain('bun standards github --apply');
      expect(documentation).toContain(
        'installs and verifies classic protection before deleting',
      );
    }

    const seedDocumentation = readFileSync(SEED_README, 'utf8');
    expect(seedDocumentation).not.toContain('v0.4');
    expect(seedDocumentation).not.toContain(
      'bun add --dev --exact @davidvornholt/standards@0.5.0',
    );
    expect(seedDocumentation).not.toContain('legacy repository-level');
    expect(seedDocumentation).not.toContain('STANDARDS_SYNC_TOKEN');

    const skillDocumentation = readFileSync(SYNC_SKILL, 'utf8');
    expect(skillDocumentation).toContain('published package migration guide');
    expect(skillDocumentation).not.toContain(
      'bun add --dev --exact @davidvornholt/standards@0.5.0',
    );
    expect(skillDocumentation).not.toContain('STANDARDS_SYNC_TOKEN');
  });
});
