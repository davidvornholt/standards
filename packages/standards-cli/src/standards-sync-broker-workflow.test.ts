import { describe, expect, it } from 'bun:test';
import {
  assertSecuritySensitiveSteps,
  clearName,
  expression,
  type MutableWorkflow,
  namedStep,
  parsedWorkflow,
  prMintName,
  prToken,
  syncName,
  syncPolicyRefName,
  workflowSource,
  writerMintName,
  writerToken,
} from './standards-sync-broker-workflow-contract';

const mutableStep = (
  workflow: MutableWorkflow,
  name: string,
): Record<string, unknown> =>
  namedStep(workflow, name) as Record<string, unknown>;
const rejectsMutation = (
  mutate: (workflow: MutableWorkflow) => void,
): boolean => {
  const workflow = structuredClone(parsedWorkflow) as MutableWorkflow;
  mutate(workflow);
  try {
    assertSecuritySensitiveSteps(workflow);
    return false;
  } catch {
    return true;
  }
};
const moveStepAfterSync = (workflow: MutableWorkflow, name: string): void => {
  const { steps } = workflow.jobs.sync;
  const selectedIndex = steps.findIndex((step) => step.name === name);
  const [selectedStep] = steps.splice(selectedIndex, 1);
  const syncIndex = steps.findIndex((candidate) => candidate.name === syncName);
  steps.splice(syncIndex + 1, 0, selectedStep);
};
const addTokenConsumer =
  (token: string) =>
  (workflow: MutableWorkflow): void => {
    workflow.jobs.sync.steps.push({
      name: 'Consume broker token again',
      env: { leakedToken: token },
      run: 'true',
    });
  };

describe('Standards sync broker credential contract', () => {
  it('pins exact fail-closed mappings, token isolation, and ordering', () => {
    assertSecuritySensitiveSteps(parsedWorkflow);
    expect(parsedWorkflow.permissions).toEqual({ contents: 'read' });
    expect(
      namedStep(parsedWorkflow, 'Checkout').with?.['persist-credentials'],
    ).toBe(false);
    expect(namedStep(parsedWorkflow, syncName).env).toEqual({
      [syncPolicyRefName]: expression('needs.policy.outputs.ref'),
    });
    expect(
      workflowSource.match(/steps\.sync-branch\.outputs\.branch/gu) ?? [],
    ).toHaveLength(1);
  });

  it('rejects softened mappings, token reuse, and unsafe ordering', () => {
    const sensitiveNames = [
      writerMintName,
      prMintName,
      'Commit and push mirror changes',
      'Open a pull request if the mirror changed',
    ];
    const mutations: Array<(workflow: MutableWorkflow) => void> =
      sensitiveNames.map((name) => (workflow) => {
        mutableStep(workflow, name)['continue-on-error'] = true;
      });
    mutations.push(
      (workflow) => {
        Reflect.deleteProperty(mutableStep(workflow, writerMintName), 'id');
      },
      (workflow) => {
        mutableStep(workflow, prMintName).id = 'changed';
      },
      (workflow) => moveStepAfterSync(workflow, writerMintName),
      (workflow) => moveStepAfterSync(workflow, prMintName),
      addTokenConsumer(writerToken),
      addTokenConsumer(prToken),
      (workflow) => moveStepAfterSync(workflow, clearName),
    );
    const rejected = mutations.map(rejectsMutation);
    expect(rejected).toEqual(rejected.map(() => true));
  });
});
