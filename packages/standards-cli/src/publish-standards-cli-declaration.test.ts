import { describe, expect, it } from 'bun:test';
import {
  githubExpression,
  publishWorkflowJobs,
  stepEnvironmentEntries,
  workflowStep,
} from './publish-workflow-fixture';

const publishJob = () => publishWorkflowJobs().publish ?? {};

describe('standards CLI release declaration gating', () => {
  it('releases only the commit that declares the version', () => {
    const declaration = workflowStep(
      publishJob(),
      'Determine release declaration',
    );
    expect(declaration.if).toBeUndefined();
    expect(declaration.run).toContain('git rev-parse --verify "$RELEASE_SHA^"');
    expect(declaration.run).toContain('git show "$parent:$PACKAGE_PATH"');
    expect(declaration.run).toContain(
      'declaration "$version" "$previous_version"',
    );
    expect(declaration.run).toContain('declared) declared=true');
    for (const arm of ['unchanged)', 'withdrawn)']) {
      const body = declaration.run?.slice(declaration.run.indexOf(arm)) ?? '';
      expect(body.slice(0, body.indexOf(';;'))).toContain('declared=false');
    }
    expect(declaration.run).toContain('echo "declared=$declared"');
  });

  it('carries the declaration into the job outputs that gate the release', () => {
    expect(publishJob().outputs).toMatchObject({
      declared: githubExpression('steps.declaration.outputs.declared'),
      version: githubExpression('steps.declaration.outputs.version'),
    });
    expect(publishWorkflowJobs().release?.if).toBe(
      "needs.publish.result == 'success' && needs.publish.outputs.declared == 'true'",
    );
  });

  it('stops an unchanged version before any registry or release work', () => {
    for (const name of [
      'Setup Bun',
      'Install release dependencies',
      'Determine release state',
    ]) {
      expect(workflowStep(publishJob(), name).if).toBe(
        "steps.declaration.outputs.declared == 'true'",
      );
    }
    expect(workflowStep(publishJob(), 'Determine release state').run).toContain(
      'registry.npmjs.org',
    );
  });

  it('fails an inherited version whose release never produced its tag', () => {
    const completion = workflowStep(
      publishJob(),
      'Verify the inherited release completed',
    );
    expect(completion.if).toBe("steps.declaration.outputs.declared == 'false'");
    expect(completion.run).toContain('refs/tags/v$VERSION');
    expect(completion.run).toContain('exit 1');
  });

  it('refuses to publish once main advanced past the declaring commit', () => {
    const tip = workflowStep(
      publishJob(),
      'Verify the declaring commit is still the tip of main',
    );
    expect(tip.if).toBe("steps.declaration.outputs.declared == 'true'");
    expect(stepEnvironmentEntries(tip)).toEqual([
      ['PROVENANCE_SHA', githubExpression('github.sha')],
      ['RELEASE_SHA', githubExpression('github.event.workflow_run.head_sha')],
    ]);
    expect(tip.run).toContain('"$PROVENANCE_SHA" != "$RELEASE_SHA"');
    expect(tip.run).toContain('exit 1');
  });
});
