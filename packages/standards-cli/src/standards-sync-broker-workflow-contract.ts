import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { ACTUAL_UPSTREAM } from './cli-test-support';

type WorkflowStep = {
  readonly env?: Readonly<Record<string, string>>;
  readonly id?: string;
  readonly if?: string;
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, string | boolean>>;
};
type ParsedWorkflow = {
  readonly permissions: Readonly<Record<string, string>>;
  readonly jobs: {
    readonly sync: {
      readonly environment?: string;
      readonly steps: ReadonlyArray<WorkflowStep>;
    };
  };
};
export type TokenConsumerContracts = {
  readonly pullRequest: WorkflowStep;
  readonly writer: WorkflowStep;
};
export type MutableWorkflow = {
  permissions: Record<string, string>;
  jobs: { sync: { environment?: string; steps: Array<WorkflowStep> } };
};

const workflowPath = join(
  ACTUAL_UPSTREAM,
  '.github/workflows/standards-sync.yml',
);
export const workflowSource = readFileSync(workflowPath, 'utf8');
export const parsedWorkflow = parseYaml(workflowSource) as ParsedWorkflow;
export const expression = (value: string): string =>
  ['$', '{{ ', value, ' }}'].join('');
export const namedStep = (
  workflow: ParsedWorkflow,
  name: string,
): WorkflowStep => {
  const step = workflow.jobs.sync.steps.find(
    (candidate) => candidate.name === name,
  );
  if (step === undefined) {
    throw new Error(`Missing Standards sync workflow step: ${name}`);
  }
  return step;
};
const stepIndex = (workflow: ParsedWorkflow, name: string): number => {
  const indexes = workflow.jobs.sync.steps.flatMap((step, candidateIndex) =>
    step.name === name ? [candidateIndex] : [],
  );
  const [index] = indexes;
  if (index === undefined || indexes.length !== 1) {
    throw new Error(`Expected exactly one Standards sync step: ${name}`);
  }
  return index;
};
export const writerToken = expression(
  'steps.branch-writer-token.outputs.token',
);
export const prToken = expression('steps.pr-token.outputs.token');
const resolveIdName = 'Resolve broker App ID';
const resolveKeyName = 'Resolve broker App private key';
export const writerMintName = 'Mint current-repository branch writer token';
export const prMintName = 'Mint current-repository PR token';
export const clearName = 'Clear broker App credentials';
export const syncName = 'Sync canonical files from upstream';
const writerConsumerName = 'Commit and push mirror changes';
const prConsumerName = 'Open a pull request if the mirror changed';
export const syncPolicyRefName = ['SYNC', 'POLICY', 'REF'].join('_');

const assertExactStep = (
  workflow: ParsedWorkflow,
  name: string,
  expected: WorkflowStep,
): void => {
  if (!isDeepStrictEqual(namedStep(workflow, name), expected)) {
    throw new Error(`${name} does not match its exact workflow contract`);
  }
};
const resolvedSecretStep = (
  name: string,
  secretKey: string,
  envName: string,
): WorkflowStep => ({
  name,
  uses: './.github/actions/sops-secret',
  with: {
    'age-key': expression('secrets[needs.policy.outputs.sync-age-key-secret]'),
    'secret-file': `secrets/${expression(
      'needs.policy.outputs.sync-secret-target',
    )}.yaml`,
    'secret-key': `${expression(
      'needs.policy.outputs.sync-broker-app-key',
    )}.${secretKey}`,
    'env-name': envName,
  },
});
const mintedTokenStep = (
  name: string,
  id: string,
  contents: string,
  permission: string,
): WorkflowStep => ({
  name,
  id,
  uses: 'actions/create-github-app-token@v3',
  with: {
    'app-id': expression('env.BROKER_APP_ID'),
    'private-key': expression('env.BROKER_APP_PRIVATE_KEY'),
    'permission-contents': contents,
    [permission]: 'write',
  },
});
const assertSoleTokenConsumer = (
  workflow: ParsedWorkflow,
  producerName: string,
  producerId: string,
  consumerName: string,
): void => {
  const producerIndex = stepIndex(workflow, producerName);
  const consumerIndex = stepIndex(workflow, consumerName);
  const hasExtraConsumer = workflow.jobs.sync.steps.some(
    (step, index) =>
      index !== producerIndex &&
      index !== consumerIndex &&
      JSON.stringify(step).includes(producerId),
  );
  if (hasExtraConsumer) {
    throw new Error(`${producerName} must have exactly one workflow consumer`);
  }
};

export const assertSecuritySensitiveSteps = (
  workflow: ParsedWorkflow,
  consumers: TokenConsumerContracts,
): void => {
  assertExactStep(
    workflow,
    resolveIdName,
    resolvedSecretStep(resolveIdName, 'app_id', 'BROKER_APP_ID'),
  );
  assertExactStep(
    workflow,
    resolveKeyName,
    resolvedSecretStep(resolveKeyName, 'private_key', 'BROKER_APP_PRIVATE_KEY'),
  );
  assertExactStep(
    workflow,
    writerMintName,
    mintedTokenStep(
      writerMintName,
      'branch-writer-token',
      'write',
      'permission-workflows',
    ),
  );
  assertExactStep(
    workflow,
    prMintName,
    mintedTokenStep(prMintName, 'pr-token', 'read', 'permission-pull-requests'),
  );
  assertExactStep(workflow, clearName, {
    name: clearName,
    run: `{
  echo "BROKER_APP_ID="
  echo "BROKER_APP_PRIVATE_KEY="
} >> "$GITHUB_ENV"
`,
  });
  assertExactStep(workflow, writerConsumerName, consumers.writer);
  assertExactStep(workflow, prConsumerName, consumers.pullRequest);

  const syncIndex = stepIndex(workflow, syncName);
  const resolveIdIndex = stepIndex(workflow, resolveIdName);
  const resolveKeyIndex = stepIndex(workflow, resolveKeyName);
  const writerIndex = stepIndex(workflow, writerMintName);
  const prIndex = stepIndex(workflow, prMintName);
  const clearIndex = stepIndex(workflow, clearName);
  if (
    resolveKeyIndex !== resolveIdIndex + 1 ||
    writerIndex !== resolveKeyIndex + 1 ||
    prIndex !== writerIndex + 1 ||
    clearIndex !== prIndex + 1 ||
    clearIndex >= syncIndex
  ) {
    throw new Error('Broker credentials must form a contiguous pre-sync block');
  }
  assertSoleTokenConsumer(
    workflow,
    writerMintName,
    'branch-writer-token',
    writerConsumerName,
  );
  assertSoleTokenConsumer(workflow, prMintName, 'pr-token', prConsumerName);
};
