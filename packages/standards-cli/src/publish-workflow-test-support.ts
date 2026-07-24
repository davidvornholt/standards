import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const WORKFLOW_PATH = join(
  import.meta.dir,
  '../../../.github/workflows/publish-standards-cli.yml',
);

export const githubExpression = (property: string): string =>
  `${'$'}{{ ${property} }}`;

export type WorkflowStep = {
  readonly name?: unknown;
  readonly if?: unknown;
  readonly env?: unknown;
  readonly run?: string;
};

export type WorkflowJob = {
  readonly if?: unknown;
  readonly needs?: unknown;
  readonly outputs?: unknown;
  readonly steps?: unknown;
};

export const publishWorkflowJobs = (): Readonly<
  Record<string, WorkflowJob>
> => {
  const workflow: unknown = parse(readFileSync(WORKFLOW_PATH, 'utf8'));
  if (
    typeof workflow !== 'object' ||
    workflow === null ||
    !('jobs' in workflow) ||
    typeof workflow.jobs !== 'object' ||
    workflow.jobs === null
  ) {
    throw new Error('Publish workflow must contain jobs');
  }
  return workflow.jobs as Readonly<Record<string, WorkflowJob>>;
};

export const workflowStep = (job: WorkflowJob, name: string): WorkflowStep => {
  if (!Array.isArray(job.steps)) {
    throw new Error('Workflow job must contain steps');
  }
  const match = job.steps.find(
    (candidate): candidate is WorkflowStep =>
      typeof candidate === 'object' &&
      candidate !== null &&
      'name' in candidate &&
      candidate.name === name,
  );
  if (match === undefined) {
    throw new Error(`Workflow step not found: ${name}`);
  }
  return match;
};

export const workflowStepNames = (job: WorkflowJob): ReadonlyArray<string> => {
  if (!Array.isArray(job.steps)) {
    throw new Error('Workflow job must contain steps');
  }
  return job.steps.map((candidate: WorkflowStep) =>
    typeof candidate.name === 'string' ? candidate.name : '',
  );
};

// A Map keeps the environment names exactly as the workflow spells them without
// inventing camelCase test keys, and without pinning the order two YAML keys
// happen to appear in, which carries no behavior.
export const stepEnvironment = (
  step: WorkflowStep,
): ReadonlyMap<string, unknown> => {
  if (typeof step.env !== 'object' || step.env === null) {
    throw new Error('Workflow step must declare an environment');
  }
  return new Map(Object.entries(step.env));
};
