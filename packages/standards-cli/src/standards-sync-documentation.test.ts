import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPORTED_REPOSITORY_SETTING_KEYS } from './github-settings';
import { REPOSITORY_OWNED_CONTROL_SEAMS } from './sync-control-seams';

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
const PREFLIGHT_RUNTIME_VARIABLES = [
  'GITHUB_EVENT_NAME',
  'GITHUB_OUTPUT',
  'GITHUB_WORKSPACE',
] as const;
const CONTROL_SEAM_PREFIX =
  'Contract-v1 sources must not manage the repository-owned control seams ';
const formatList = (values: ReadonlyArray<string>): string => {
  const quoted = values.map((value) => `\`${value}\``);
  const last = quoted.at(-1);
  return last === undefined
    ? ''
    : `${quoted.slice(0, -1).join(', ')}, or ${last}`;
};
const CONTROL_SEAM_SENTENCE = `${CONTROL_SEAM_PREFIX}${formatList(REPOSITORY_OWNED_CONTROL_SEAMS)}.`;

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
      expect(documentation).toContain(CONTROL_SEAM_SENTENCE);
      expect(documentation.split(CONTROL_SEAM_PREFIX)).toHaveLength(2);
      expect(documentation).toContain(
        'The lock persists every observed repository-owned seed path, and sync rejects implicit seed-to-managed or managed-to-seed ownership changes before mutation',
      );
      expect(documentation).toContain('STANDARDS_SYNC_ENVIRONMENT_TOKEN');
      expect(documentation).toContain(
        'Contents, Pull requests, and Workflows repository permissions set to write',
      );
      expect(documentation).toContain('classic branch protection');
      expect(documentation).toContain('ruleset-only');
      expect(documentation).toContain("repository's default branch");
      expect(documentation).not.toContain('protected-branch-only');
      expect(documentation).not.toContain('permits only branches protected');
      expect(documentation).toContain(
        `The \`repository\` object accepts exactly ${SUPPORTED_REPOSITORY_SETTING_KEYS.length} keys`,
      );
      for (const key of SUPPORTED_REPOSITORY_SETTING_KEYS) {
        expect(documentation).toContain(`\`${key}\``);
      }
      expect(documentation).toContain(
        'Any other repository key fails before any API request',
      );
      expect(documentation).toContain(
        `canonical declaration currently owns all ${SUPPORTED_REPOSITORY_SETTING_KEYS.length} repository keys`,
      );
      expect(documentation).toContain(
        'currently extends only `rulesets` and `environments`',
      );
      expect(documentation).toContain(
        'a collision that fails instead of overriding canonical state',
      );
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

describe('generated standards sync preflight documentation', () => {
  it('documents the generated preflight runtime environment', () => {
    const documentation = readFileSync(PACKAGE_README, 'utf8');
    const configuration = documentation
      .split('## Configuration\n', 2)
      .at(1)
      ?.split('\n## ', 1)
      .at(0);

    expect(configuration).toBeDefined();
    for (const variable of PREFLIGHT_RUNTIME_VARIABLES) {
      expect(configuration).toContain(`\`${variable}\``);
    }
    expect(configuration).toContain(
      'required for the generated preflight action',
    );
    expect(configuration).toContain('no defaults');
    expect(configuration).toContain('GitHub Actions supplies all three');
    expect(configuration).toContain('`schedule` or `repository_dispatch`');
    expect(configuration).toContain('scheduled runs honor `scheduledSync`');
    expect(configuration).toContain(
      'repository dispatches always request a sync',
    );
    expect(configuration).toContain('writes its `run_sync` output');
    expect(configuration).toContain('consumer repository root');
    expect(configuration).toContain('reads `package.json`');
    expect(configuration).toContain('`sync-standards.local.json`');
  });
});
