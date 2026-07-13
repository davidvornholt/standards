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
const MANIFEST = join(ROOT, 'sync-standards.json');
const SYNC_SKILL = join(ROOT, '.agents/skills/standards-sync/SKILL.md');
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
    expect(checkoutStep).toContain('ref: main');
    const preflightStep = workflowStep(workflow, 'Check scheduled sync policy');
    expect(preflightStep).toContain(
      'uses: ./.github/actions/standards-sync-preflight',
    );
    expect(preflightStep).not.toContain('run: node');
    expect(action).toContain('using: node24');
    expect(action).toContain('main: index.mjs');
    for (const name of GATED_STEPS) {
      expect(workflowStep(workflow, name)).toContain(
        "if: steps.preflight.outputs.run_sync == 'true'",
      );
    }
  });

  it('keeps workflow and action metadata valid YAML', () => {
    expect(() => BunYaml.parse(readFileSync(WORKFLOW, 'utf8'))).not.toThrow();
    expect(() => BunYaml.parse(readFileSync(ACTION, 'utf8'))).not.toThrow();
  });

  it('syncs the complete local action as canonical content', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      readonly paths: ReadonlyArray<string>;
    };

    expect(manifest.paths).toContain(
      '.github/actions/standards-sync-preflight',
    );
    expect(manifest.paths).not.toContain(
      '.github/scripts/standards-sync-preflight.mjs',
    );
  });

  it('documents migration and configured-ref recovery accurately', () => {
    for (const path of POLICY_DOCS) {
      const documentation = readFileSync(path, 'utf8');
      expect(documentation).toContain('@davidvornholt/standards` >=0.5.0');
      expect(documentation).toContain('declared as an exact stable version');
      expect(documentation).toContain(
        'bun add --dev --exact @davidvornholt/standards@0.5.0',
      );
    }
    expect(readFileSync(SYNC_SKILL, 'utf8')).toContain(
      'real sync from configured remote ref',
    );
  });
});
