import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ACTUAL_UPSTREAM } from './cli-test-support';

type Step = {
  readonly id?: string;
  readonly name?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, string | boolean>>;
};

type Job = {
  readonly environment?: string;
  readonly if?: string;
  readonly needs?: string;
  readonly steps: ReadonlyArray<Step>;
};

type Workflow = {
  readonly jobs: {
    readonly policy: Job;
    readonly notify: Job;
  };
};

const expression = (value: string): string =>
  ['$', '{{ ', value, ' }}'].join('');
const workflow = parseYaml(
  readFileSync(
    join(ACTUAL_UPSTREAM, '.github/workflows/notify-pause.yml'),
    'utf8',
  ),
) as Workflow;
const namedStep = (job: Job, name: string): Step => {
  const step = job.steps.find((candidate) => candidate.name === name);
  if (step === undefined) {
    throw new Error(`Missing Notify pause step: ${name}`);
  }
  return step;
};

describe('Notify pause credential isolation', () => {
  it('binds the secret-bearing job to the policy-selected environment', () => {
    expect(workflow.jobs.notify.needs).toBe('policy');
    expect(workflow.jobs.notify.environment).toBe(
      expression(
        "needs.policy.outputs.notification-environment || fromJSON('null')",
      ),
    );
    expect(namedStep(workflow.jobs.policy, 'Read workflow policy')).toEqual({
      name: 'Read workflow policy',
      id: 'read',
      uses: './.github/actions/read-standards-policy',
    });
  });

  it('resolves only the policy-selected age secret, target, and topic key', () => {
    expect(
      namedStep(workflow.jobs.notify, 'Resolve notification topic URL'),
    ).toEqual({
      name: 'Resolve notification topic URL',
      uses: './.github/actions/sops-secret',
      with: {
        'age-key': expression(
          'secrets[needs.policy.outputs.notification-age-key-secret]',
        ),
        'secret-file': `secrets/${expression(
          'needs.policy.outputs.notification-secret-target',
        )}.yaml`,
        'secret-key': expression('needs.policy.outputs.notification-topic-key'),
        'env-name': 'NTFY_TOPIC_URL',
      },
    });
  });
});
