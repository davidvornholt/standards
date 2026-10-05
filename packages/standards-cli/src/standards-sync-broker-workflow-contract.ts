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
    readonly sync: { readonly steps: ReadonlyArray<WorkflowStep> };
  };
};
export type TokenConsumerContracts = {
  readonly pullRequest: WorkflowStep;
  readonly writer: WorkflowStep;
};
export type MutableWorkflow = {
  permissions: Record<string, string>;
  jobs: { sync: { steps: Array<WorkflowStep> } };
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
export const appIdOutput = expression('steps.broker-app-id.outputs.value');
export const clientIdOutput = expression(
  'steps.broker-app-client-id.outputs.value',
);
export const clientIdPresence = 'steps.client-id-presence.outputs.present';
export const privateKeyOutput = expression(
  'steps.broker-app-private-key.outputs.value',
);
export const resolveIdName = 'Resolve broker App ID';
export const detectClientIdName = 'Detect broker App client ID';
export const resolveClientIdName = 'Resolve broker App client ID';
const resolveKeyName = 'Resolve broker App private key';
export const writerMintName = 'Mint current-repository branch writer token';
export const prMintName = 'Mint current-repository PR token';
export const syncName = 'Sync canonical files from upstream';
const writerConsumerName = 'Commit and push mirror changes';
const prConsumerName = 'Reconcile sync pull requests';
export const syncPolicyRefName = ['SYNC', 'POLICY', 'REF'].join('_');

// Any new field can change execution or failure semantics. Even safe metadata
// additions require an explicit contract update so reviewers see the change.
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
  id: string,
  secretKey: string,
): WorkflowStep => ({
  name,
  id,
  uses: './.github/actions/sops-secret',
  with: {
    'age-key': expression('secrets.SOPS_AGE_KEY'),
    'secret-file': 'secrets/ci.yaml',
    'secret-key': secretKey,
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
    'client-id': clientIdOutput,
    'app-id': appIdOutput,
    'private-key': privateKeyOutput,
    'permission-contents': contents,
    [permission]: 'write',
  },
});
// Matching the bare step id also catches bracket and spacing variants of the
// output expression, so a step can only read a value by being listed here.
const assertOnlyConsumers = (
  workflow: ParsedWorkflow,
  producerName: string,
  producerId: string,
  consumerNames: ReadonlyArray<string>,
): void => {
  const allowed = new Set(
    [producerName, ...consumerNames].map((name) => stepIndex(workflow, name)),
  );
  const hasExtraConsumer = workflow.jobs.sync.steps.some(
    (step, index) =>
      !allowed.has(index) && JSON.stringify(step).includes(producerId),
  );
  if (hasExtraConsumer) {
    throw new Error(
      `${producerName} must be read only by ${consumerNames.join(' and ')}`,
    );
  }
};

// The presence check reads only key names, so its script is covered by
// behavior tests. Its shape is pinned here: an added `continue-on-error`,
// `if`, or `env` would change when the client ID resolver runs.
const assertPresenceStep = (workflow: ParsedWorkflow): void => {
  const step = namedStep(workflow, detectClientIdName);
  const keys = Object.keys(step).sort((left, right) =>
    left.localeCompare(right),
  );
  if (
    !isDeepStrictEqual(keys, ['id', 'name', 'run']) ||
    step.id !== 'client-id-presence'
  ) {
    throw new Error(
      `${detectClientIdName} must be a plain run step with id client-id-presence`,
    );
  }
};

export const assertSecuritySensitiveSteps = (
  workflow: ParsedWorkflow,
  consumers: TokenConsumerContracts,
): void => {
  assertExactStep(
    workflow,
    resolveIdName,
    resolvedSecretStep(resolveIdName, 'broker-app-id', 'broker_app.app_id'),
  );
  assertPresenceStep(workflow);
  assertExactStep(workflow, resolveClientIdName, {
    ...resolvedSecretStep(
      resolveClientIdName,
      'broker-app-client-id',
      'broker_app.client_id',
    ),
    if: `${clientIdPresence} == 'true'`,
  });
  assertExactStep(
    workflow,
    resolveKeyName,
    resolvedSecretStep(
      resolveKeyName,
      'broker-app-private-key',
      'broker_app.private_key',
    ),
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
  assertExactStep(workflow, writerConsumerName, consumers.writer);
  assertExactStep(workflow, prConsumerName, consumers.pullRequest);

  const syncIndex = stepIndex(workflow, syncName);
  const block = [
    resolveIdName,
    detectClientIdName,
    resolveClientIdName,
    resolveKeyName,
    writerMintName,
    prMintName,
  ].map((name) => stepIndex(workflow, name));
  const [firstIndex = 0] = block;
  const prIndex = block.at(-1) ?? syncIndex;
  if (
    block.some((index, position) => index !== firstIndex + position) ||
    prIndex >= syncIndex
  ) {
    throw new Error('Broker credentials must form a contiguous pre-sync block');
  }
  const mintNames = [writerMintName, prMintName];
  assertOnlyConsumers(workflow, resolveIdName, 'broker-app-id', mintNames);
  assertOnlyConsumers(workflow, detectClientIdName, 'client-id-presence', [
    resolveClientIdName,
  ]);
  assertOnlyConsumers(
    workflow,
    resolveClientIdName,
    'broker-app-client-id',
    mintNames,
  );
  assertOnlyConsumers(
    workflow,
    resolveKeyName,
    'broker-app-private-key',
    mintNames,
  );
  assertOnlyConsumers(workflow, writerMintName, 'branch-writer-token', [
    writerConsumerName,
  ]);
  assertOnlyConsumers(workflow, prMintName, 'pr-token', [prConsumerName]);
};
