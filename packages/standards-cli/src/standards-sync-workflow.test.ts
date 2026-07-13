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
const AGENT_CONTRACT = join(ROOT, 'AGENTS.md');
const SYNC_SKILL = join(ROOT, '.agents/skills/standards-sync/SKILL.md');
const ZERO_INSTALL_EFFECT_BOUNDARIES = [
  '`.github/actions/standards-sync-preflight` action and its dependency-free helper closure',
  '`packages/standards-release/scripts/classify-release.ts` and its dependency-free helper closure',
  'published `packages/standards-cli/src/cli.ts` executable and its built-in-only helper closure listed in the package `files` allowlist',
] as const;
const GATED_STEPS = [
  'Setup Bun',
  'Install dependencies',
  'Sync canonical files from upstream',
  'Open a pull request if the mirror changed',
] as const;
const POLICY_DOCS = [
  join(ROOT, 'README.md'),
  join(ROOT, 'template/README.md'),
  join(ROOT, 'packages/standards-cli/README.md'),
  SYNC_SKILL,
] as const;

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
  it('enumerates the complete dependency-free Effect exception boundary', () => {
    const contract = readFileSync(AGENT_CONTRACT, 'utf8');
    expect(contract).toContain(
      'Zero-install preconditions and the published standalone bootstrap CLI are the only exceptions to the Effect rules',
    );
    for (const boundary of ZERO_INSTALL_EFFECT_BOUNDARIES) {
      expect(contract).toContain(boundary);
    }
    expect(contract).toContain(
      'All code outside those enumerated boundaries, including release packing, registry inspection, publishing decisions, and GitHub Release reconciliation',
    );
  });

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
    expect(
      readFileSync(
        join(ROOT, '.github/actions/standards-sync-preflight/index.mjs'),
        'utf8',
      ),
    ).toContain('../../../packages/standards-cli/src/sync-policy.ts');
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
    expect(environment?.deployment_branch_policies).toEqual([]);
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
    expect(manifest.paths).toContain(
      'packages/standards-cli/src/sync-policy.ts',
    );
    expect(manifest.paths).not.toContain(
      '.github/scripts/standards-sync-preflight.mjs',
    );
  });
});

describe('standards sync documentation', () => {
  it('documents migration and configured-ref recovery accurately', () => {
    for (const path of POLICY_DOCS) {
      const documentation = readFileSync(path, 'utf8');
      expect(documentation).toContain('@davidvornholt/standards` >=0.5.0');
      expect(documentation).toContain('declared as an exact stable version');
      expect(documentation).toContain('for every policy');
      expect(documentation).toContain('first land the bucket-2 CLI upgrade');
      expect(documentation).toContain(
        'bun add --dev --exact @davidvornholt/standards@0.5.0',
      );
    }
    expect(readFileSync(SYNC_SKILL, 'utf8')).toContain(
      'real sync from configured remote ref',
    );
    const rootDocumentation = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const templateDocumentation = readFileSync(
      join(ROOT, 'template/README.md'),
      'utf8',
    );
    for (const documentation of [
      rootDocumentation,
      templateDocumentation,
      readFileSync(join(ROOT, 'packages/standards-cli/README.md'), 'utf8'),
      readFileSync(SYNC_SKILL, 'utf8'),
    ]) {
      expect(documentation).toContain('protected `standards-sync`');
      expect(documentation).toContain('repository dispatch');
      expect(documentation).toContain('syncPolicyContractVersion');
      expect(documentation).toContain('STANDARDS_SYNC_ENVIRONMENT_TOKEN');
      expect(documentation).toContain('legacy repository-level');
      expect(documentation).toContain('STANDARDS_SYNC_TOKEN');
      expect(documentation).toContain('admits protected branches generally');
      expect(documentation).toContain(
        "bind the workflow to the repository's default branch",
      );
      expect(documentation).toContain(
        'canonical default-branch ruleset protects that branch',
      );
      expect(documentation).not.toContain('protected-branch-only');
      expect(documentation).not.toContain('permits only branches protected');
      expect(documentation).toContain(
        "run a bare `bun standards sync` from the repository's default branch",
      );
      expect(documentation).toContain('bun standards github --apply');
    }
  });
});
