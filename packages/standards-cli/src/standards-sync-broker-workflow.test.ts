import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ACTUAL_UPSTREAM } from './cli-test-support';

type WorkflowStep = {
  readonly env?: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, string | boolean>>;
};

const WORKFLOW_PATH = join(
  ACTUAL_UPSTREAM,
  '.github/workflows/standards-sync.yml',
);
const workflowSource = readFileSync(WORKFLOW_PATH, 'utf8');
const parsedWorkflow = parseYaml(workflowSource) as {
  readonly permissions: Readonly<Record<string, string>>;
  readonly jobs: {
    readonly sync: { readonly steps: ReadonlyArray<WorkflowStep> };
  };
};
const {
  jobs: {
    sync: { steps },
  },
} = parsedWorkflow;
const expression = (value: string): string =>
  ['$', '{{ ', value, ' }}'].join('');
const namedStep = (name: string): WorkflowStep => {
  const step = steps.find((candidate) => candidate.name === name);
  if (step === undefined) {
    throw new Error(`Missing Standards sync workflow step: ${name}`);
  }
  return step;
};
const stepIndex = (name: string): number =>
  steps.findIndex((candidate) => candidate.name === name);
describe('Standards sync broker credential contract', () => {
  it('resolves both nested App credentials through the trusted pre-sync action', () => {
    const appId = namedStep('Resolve broker App ID');
    const privateKey = namedStep('Resolve broker App private key');
    const syncIndex = stepIndex('Sync canonical files from upstream');

    expect(appId.uses).toBe('./.github/actions/sops-secret');
    expect(appId.with).toEqual({
      'age-key': expression('secrets.SOPS_AGE_KEY'),
      'secret-file': 'secrets/ci.yaml',
      'secret-key': 'broker_app.app_id',
      'env-name': 'BROKER_APP_ID',
    });
    expect(privateKey.uses).toBe('./.github/actions/sops-secret');
    expect(privateKey.with).toEqual({
      'age-key': expression('secrets.SOPS_AGE_KEY'),
      'secret-file': 'secrets/ci.yaml',
      'secret-key': 'broker_app.private_key',
      'env-name': 'BROKER_APP_PRIVATE_KEY',
    });
    expect(stepIndex('Resolve broker App ID')).toBeLessThan(syncIndex);
    expect(stepIndex('Resolve broker App private key')).toBeLessThan(syncIndex);
  });

  it('mints fail-closed v3 tokens for exactly the current repository and responsibilities', () => {
    const writer = namedStep('Mint current-repository branch writer token');
    const pr = namedStep('Mint current-repository PR token');

    expect(writer.uses).toBe('actions/create-github-app-token@v3');
    expect(writer.with).toEqual({
      'app-id': expression('env.BROKER_APP_ID'),
      'private-key': expression('env.BROKER_APP_PRIVATE_KEY'),
      'permission-contents': 'write',
      'permission-workflows': 'write',
    });
    expect(pr.uses).toBe('actions/create-github-app-token@v3');
    expect(pr.with).toEqual({
      'app-id': expression('env.BROKER_APP_ID'),
      'private-key': expression('env.BROKER_APP_PRIVATE_KEY'),
      'permission-contents': 'read',
      'permission-pull-requests': 'write',
    });
    for (const mint of [writer, pr]) {
      expect(mint.with).not.toHaveProperty('owner');
      expect(mint.with).not.toHaveProperty('repositories');
      expect(JSON.stringify(mint.with)).not.toContain('github.event');
      expect(JSON.stringify(mint.with)).not.toContain(
        'github.repository_owner',
      );
    }
    expect(workflowSource).not.toContain('failure-mode: fallback');
    expect(workflowSource).not.toContain('fallback-value:');
  });

  it('keeps installation tokens and checkout credentials out of sync', () => {
    const checkout = namedStep('Checkout');
    const sync = namedStep('Sync canonical files from upstream');
    const open = namedStep('Open a pull request if the mirror changed');
    const writerToken = expression('steps.branch-writer-token.outputs.token');
    const prToken = expression('steps.pr-token.outputs.token');

    expect(parsedWorkflow.permissions).toEqual({ contents: 'read' });
    expect(checkout.with?.['persist-credentials']).toBe(false);
    expect(sync.env?.SYNC_POLICY_REF).toBe(
      expression('needs.policy.outputs.ref'),
    );
    expect(Object.keys(sync.env ?? {})).toEqual(['SYNC_POLICY_REF']);
    expect(sync.run).not.toContain(writerToken);
    expect(sync.run).not.toContain(prToken);
    expect(open.env?.BRANCH_WRITER_TOKEN).toBe(writerToken);
    expect(open.env?.GH_TOKEN).toBe(prToken);
    expect(Object.keys(open.env ?? {}).sort()).toEqual([
      'BRANCH_WRITER_TOKEN',
      'GH_TOKEN',
    ]);
    expect(open.run).toContain('password=\\$BRANCH_WRITER_TOKEN');
    expect(open.run).not.toContain('password=\\$GITHUB_TOKEN');
    expect(steps.filter((step) => step.env?.GH_TOKEN === prToken)).toEqual([
      open,
    ]);
    expect(
      steps.filter((step) => step.env?.BRANCH_WRITER_TOKEN === writerToken),
    ).toEqual([open]);
    expect(stepIndex('Clear broker App credentials')).toBeLessThan(
      stepIndex('Sync canonical files from upstream'),
    );
  });
});
