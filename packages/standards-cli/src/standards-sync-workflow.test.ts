import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { YAML: BunYaml } = await import('bun');

const ROOT = join(import.meta.dir, '../../..');
const ACTION = join(
  ROOT,
  '.github/actions/standards-sync-preflight/action.yml',
);
const WORKFLOW = join(ROOT, '.github/workflows/standards-sync.yml');
const SETTINGS = join(ROOT, '.github/settings.json');
const MANIFEST = join(ROOT, 'sync-standards.json');
const SYNC_SKILL = join(ROOT, '.agents/skills/standards-sync/SKILL.md');
const ROOT_README = join(ROOT, 'README.md');
const SEED_README = join(ROOT, 'template/README.md');
const PACKAGE_README = join(ROOT, 'packages/standards-cli/README.md');
const GATED_STEPS = [
  'Setup Bun',
  'Install dependencies',
  'Sync canonical files from upstream',
  'Open a pull request if the mirror changed',
] as const;
const CURRENT_POLICY_DOCS = [
  ROOT_README,
  SEED_README,
  PACKAGE_README,
  SYNC_SKILL,
] as const;
const MIGRATION_DOCS = [ROOT_README, PACKAGE_README] as const;
const RELATIVE_IMPORT = /\bfrom"[.]{1,2}\//u;
const workflowStep = (workflow: string, name: string): string => {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  if (start === -1) {
    throw new Error(`Workflow step not found: ${name}`);
  }
  const next = workflow.indexOf('\n      - name:', start + marker.length);
  return workflow.slice(start, next === -1 ? undefined : next);
};

describe('canonical scheduled sync contract', () => {
  it('uses a runner-managed JavaScript action before every paid step', () => {
    const workflow = readFileSync(WORKFLOW, 'utf8');
    const action = readFileSync(ACTION, 'utf8');
    const checkout = workflow.indexOf('      - name: Checkout');
    const preflight = workflow.indexOf(
      '      - name: Check scheduled sync policy',
    );
    const setup = workflow.indexOf('      - name: Setup Bun');

    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeGreaterThan(checkout);
    expect(setup).toBeGreaterThan(preflight);
    const checkoutStep = workflowStep(workflow, 'Checkout');
    expect(checkoutStep).toContain('uses: actions/checkout@v6');
    expect(checkoutStep).not.toContain('ref:');
    expect(workflow).toContain('repository_dispatch:');
    expect(workflow).toContain('types: [standards-sync]');
    expect(workflow).not.toContain('workflow_dispatch:');
    expect(workflow).toContain('environment: standards-sync');
    expect(workflow).toContain('The environment admits');
    expect(workflow).toContain('protected branches generally');
    expect(workflow).toContain("repository's default branch");
    expect(workflow).toContain('canonical default-branch ruleset protects');
    expect(
      workflowStep(workflow, 'Open a pull request if the mirror changed'),
    ).toContain(
      [
        'GH_TOKEN: $',
        '{{ secrets.STANDARDS_SYNC_ENVIRONMENT_TOKEN || secrets.GITHUB_TOKEN }}',
      ].join(''),
    );
    expect(workflow).not.toContain('secrets.STANDARDS_SYNC_TOKEN');
    const preflightStep = workflowStep(workflow, 'Check scheduled sync policy');
    expect(preflightStep).toContain(
      'uses: ./.github/actions/standards-sync-preflight',
    );
    expect(preflightStep).not.toContain('run: node');
    expect(action).toContain('using: node24');
    expect(action).toContain('main: index.mjs');
    const actionBundle = readFileSync(
      join(ROOT, '.github/actions/standards-sync-preflight/index.mjs'),
      'utf8',
    );
    expect(actionBundle).toContain('Generated from packages/standards-cli');
    expect(actionBundle).not.toMatch(RELATIVE_IMPORT);
    for (const name of GATED_STEPS) {
      expect(workflowStep(workflow, name)).toContain(
        "if: steps.preflight.outputs.run_sync == 'true'",
      );
    }
  });

  it('supports a non-main default branch through event and protected-branch semantics', () => {
    const workflow = readFileSync(WORKFLOW, 'utf8');
    const settings = JSON.parse(readFileSync(SETTINGS, 'utf8')) as {
      readonly rulesets: ReadonlyArray<Record<string, unknown>>;
      readonly environments: ReadonlyArray<Record<string, unknown>>;
    };
    const checkoutStep = workflowStep(workflow, 'Checkout');
    const [ruleset] = settings.rulesets;
    const [environment] = settings.environments;

    expect(checkoutStep).not.toContain('ref: main');
    expect(JSON.stringify(ruleset)).toContain('~DEFAULT_BRANCH');
    expect(environment?.deployment_branch_policy).toEqual(
      JSON.parse('{"protected_branches":true,"custom_branch_policies":false}'),
    );
    expect(environment).not.toHaveProperty('deployment_branch_policies');
  });

  it('keeps workflow and action metadata valid YAML', () => {
    expect(() => BunYaml.parse(readFileSync(WORKFLOW, 'utf8'))).not.toThrow();
    expect(() => BunYaml.parse(readFileSync(ACTION, 'utf8'))).not.toThrow();
  });

  it('syncs the complete local action as canonical content', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      readonly paths: ReadonlyArray<string>;
      readonly syncPolicyContractVersion: unknown;
    };

    expect(manifest.syncPolicyContractVersion).toBe(1);
    expect(manifest.paths).toContain(
      '.github/actions/standards-sync-preflight',
    );
    expect(
      manifest.paths.some((path) => path.startsWith('packages/standards-cli')),
    ).toBe(false);
    expect(manifest.paths).not.toContain(
      '.github/scripts/standards-sync-preflight.mjs',
    );
  });
});

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
      expect(documentation).toContain('admits protected branches generally');
      expect(documentation).toContain(
        "bind the workflow to the repository's default branch",
      );
      expect(documentation).toContain(
        'canonical default-branch ruleset protects that branch',
      );
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
