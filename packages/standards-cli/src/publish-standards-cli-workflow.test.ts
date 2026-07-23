import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const WORKFLOW_PATH = join(
  import.meta.dir,
  '../../../.github/workflows/publish-standards-cli.yml',
);
const githubExpression = (property: string): string =>
  `${'$'}{{ ${property} }}`;

type Step = {
  readonly name?: unknown;
  readonly if?: unknown;
  readonly run?: unknown;
};

type Job = {
  readonly if?: unknown;
  readonly needs?: unknown;
  readonly steps?: unknown;
};

const jobs = (): Readonly<Record<string, Job>> => {
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
  return workflow.jobs as Readonly<Record<string, Job>>;
};

const step = (job: Job, name: string): Step => {
  if (!Array.isArray(job.steps)) {
    throw new Error('Workflow job must contain steps');
  }
  const match = job.steps.find(
    (candidate): candidate is Step =>
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

describe('standards CLI publish recovery workflow', () => {
  it('publishes a new version and reconciles its exact tested commit', () => {
    const workflowJobs = jobs();
    expect(step(workflowJobs.publish ?? {}, 'Publish package').if).toBe(
      "steps.release.outputs.publish == 'true'",
    );
    expect(workflowJobs.release?.needs).toBe('publish');
    expect(workflowJobs.release?.if).toBe("needs.publish.result == 'success'");
    expect(
      step(workflowJobs.release ?? {}, 'Checkout released commit'),
    ).toMatchObject({
      with: { ref: githubExpression('needs.publish.outputs.sha') },
    });
  });

  it('requires npm signature and provenance validation before recovering an existing version', () => {
    const verification = step(
      jobs().publish ?? {},
      'Verify existing package provenance',
    );
    expect(verification.if).toBe("steps.release.outputs.publish == 'false'");
    expect(verification.run).toContain('npm audit signatures');
    expect(verification.run).toContain('release-recovery.ts');
    expect(verification.run).toContain('provenance \\\n');
    expect(verification.run).toContain('"$attestations_file"');
  });

  it('routes existing tag and release states through the tested SHA model', () => {
    const reconciliation = step(
      jobs().release ?? {},
      'Reconcile GitHub release',
    );
    expect(reconciliation.run).toContain('release_state=published');
    expect(reconciliation.run).toContain('release_state=tag-only');
    expect(reconciliation.run).toContain('release-recovery.ts');
    expect(reconciliation.run).toContain(
      'github-state "$release_state" "$tag_sha"',
    );
  });
});
