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
const SOURCE_EXAMPLE_PATH = join(ACTUAL_UPSTREAM, 'secrets/ci.example.yaml');
const SOURCE_SECRETS_PATH = join(ACTUAL_UPSTREAM, 'secrets/ci.yaml');
const TEMPLATE_EXAMPLE_PATH = join(
  ACTUAL_UPSTREAM,
  'template/secrets/ci.example.yaml',
);
const OBSOLETE_SYNC_KEY = ['standards', 'sync', 'token'].join('_');
const BROKER_DESTINATION = 'ci:ci.broker_app';

const workflowSource = readFileSync(WORKFLOW_PATH, 'utf8');
const parsedWorkflow = parseYaml(workflowSource) as {
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
const brokerAppMapping = (
  document: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const ci = document.ci as Readonly<Record<string, unknown>>;
  const brokerEntry = Object.entries(ci).find(
    ([key]) => key === ['broker', 'app'].join('_'),
  );
  return brokerEntry?.[1] as Readonly<Record<string, unknown>>;
};

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

  it('mints a fail-closed v3 token for exactly the current repository and permissions', () => {
    const mint = namedStep('Mint current-repository PR token');

    expect(mint.uses).toBe('actions/create-github-app-token@v3');
    expect(mint.with).toEqual({
      'app-id': expression('env.BROKER_APP_ID'),
      'private-key': expression('env.BROKER_APP_PRIVATE_KEY'),
      'permission-contents': 'read',
      'permission-pull-requests': 'write',
    });
    expect(mint.with).not.toHaveProperty('owner');
    expect(mint.with).not.toHaveProperty('repositories');
    expect(JSON.stringify(mint.with)).not.toContain('github.event');
    expect(JSON.stringify(mint.with)).not.toContain('github.repository_owner');
    expect(workflowSource).not.toContain('failure-mode: fallback');
    expect(workflowSource).not.toContain('fallback-value:');
  });

  it('keeps the installation token and checkout credential out of sync', () => {
    const checkout = namedStep('Checkout');
    const sync = namedStep('Sync canonical files from upstream');
    const open = namedStep('Open a pull request if the mirror changed');
    const tokenExpression = expression('steps.broker-token.outputs.token');

    expect(checkout.with?.['persist-credentials']).toBe(false);
    expect(sync.env?.SYNC_POLICY_REF).toBe(
      expression('needs.policy.outputs.ref'),
    );
    expect(Object.keys(sync.env ?? {})).toEqual(['SYNC_POLICY_REF']);
    expect(sync.run).not.toContain(tokenExpression);
    expect(open.env?.GH_TOKEN).toBe(tokenExpression);
    expect(
      steps.filter((step) => step.env?.GH_TOKEN === tokenExpression),
    ).toEqual([open]);
    expect(stepIndex('Clear broker App credentials')).toBeLessThan(
      stepIndex('Sync canonical files from upstream'),
    );
  });

  it('removes the obsolete durable credential and keeps examples identical', () => {
    const source = readFileSync(SOURCE_EXAMPLE_PATH, 'utf8');
    const template = readFileSync(TEMPLATE_EXAMPLE_PATH, 'utf8');
    const parsed = parseYaml(source) as {
      readonly ci: Readonly<Record<string, unknown>>;
    };
    const brokerApp = brokerAppMapping(parsed);

    expect(source).toBe(template);
    expect(workflowSource).not.toContain(OBSOLETE_SYNC_KEY);
    expect(source).not.toContain(OBSOLETE_SYNC_KEY);
    expect(Object.keys(brokerApp).sort()).toEqual(['app_id', 'private_key']);
    expect(
      Object.values(brokerApp).every((value) => typeof value === 'string'),
    ).toBe(true);
  });

  it('tracks both broker App leaves as encrypted source secrets', () => {
    const encrypted = parseYaml(
      readFileSync(SOURCE_SECRETS_PATH, 'utf8'),
    ) as Readonly<Record<string, unknown>>;
    const brokerApp = brokerAppMapping(encrypted);

    expect(Object.keys(brokerApp).sort()).toEqual(['app_id', 'private_key']);
    expect(
      Object.values(brokerApp).every(
        (value) =>
          typeof value === 'string' && value.startsWith('ENC[AES256_GCM,'),
      ),
    ).toBe(true);
  });

  it('documents one provisioning command across source-owned guidance', () => {
    const rootReadme = readFileSync(join(ACTUAL_UPSTREAM, 'README.md'), 'utf8');
    const documents = [
      'packages/standards-cli/README.md',
      '.agents/skills/standards-sync/SKILL.md',
      '.agents/skills/declarative-infra/references/secrets.md',
    ].map((path) => readFileSync(join(ACTUAL_UPSTREAM, path), 'utf8'));

    for (const document of [rootReadme, ...documents]) {
      expect(document).toContain(BROKER_DESTINATION);
      expect(document).not.toContain(OBSOLETE_SYNC_KEY);
    }
    expect(rootReadme).toContain('`@davidvornholt/standards` 0.14.0 or newer');
    expect(rootReadme).toContain('`bun.lock`');
  });
});
