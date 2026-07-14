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
const QUALITY_WORKFLOW = join(ROOT, '.github/workflows/standards.yml');
const TITLE_WORKFLOW = join(ROOT, '.github/workflows/pr-title.yml');
const SETTINGS = join(ROOT, '.github/settings.json');
const MANIFEST = join(ROOT, 'sync-standards.json');
const GATED_STEPS = [
  'Setup Bun',
  'Install dependencies',
  'Sync canonical files from upstream',
  'Open a pull request if the mirror changed',
] as const;
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
    expect(workflow).toContain('canonical classic protection protects');
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
    const settings = JSON.parse(readFileSync(SETTINGS, 'utf8')) as Record<
      string,
      unknown
    >;
    const checkoutStep = workflowStep(workflow, 'Checkout');
    const [environment] = settings.environments as ReadonlyArray<
      Record<string, unknown>
    >;

    expect(checkoutStep).not.toContain('ref: main');
    expect(settings.rulesets as unknown).toEqual([]);
    expect(settings.default_branch_protection).toBeObject();
    expect(environment?.deployment_branch_policy).toEqual(
      JSON.parse('{"protected_branches":true,"custom_branch_policies":false}'),
    );
    expect(environment).not.toHaveProperty('deployment_branch_policies');
    for (const path of [QUALITY_WORKFLOW, TITLE_WORKFLOW]) {
      const producer = readFileSync(path, 'utf8');
      expect(producer).toContain('- "**"');
      expect(producer).toContain('github.event.repository.default_branch');
      expect(producer).not.toContain('- main');
    }
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
