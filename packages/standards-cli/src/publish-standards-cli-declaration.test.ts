import { describe, expect, it } from 'bun:test';
import {
  githubExpression,
  publishWorkflowJobs,
  stepEnvironment,
  workflowStep,
  workflowStepNames,
} from './publish-workflow-test-support';

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
  });

  it('publishes the values every downstream guard consumes', () => {
    const declaration = workflowStep(
      publishJob(),
      'Determine release declaration',
    );
    for (const output of [
      'echo "declared=$declared"',
      'echo "version=$version"',
      'echo "withdrawn_version=$withdrawn_version"',
    ]) {
      expect(declaration.run).toContain(output);
    }
    // Only the withdrawn arm names a version to check; every other arm has to
    // leave the output empty so the withdrawal guard stays skipped.
    const withdrawnArm =
      declaration.run?.slice(declaration.run.indexOf('withdrawn)')) ?? '';
    expect(withdrawnArm.slice(0, withdrawnArm.indexOf(';;'))).toContain(
      'withdrawn_version="$previous_version"',
    );
    expect(declaration.run).toContain('withdrawn_version=\n');
  });

  it('carries the declaration into the job outputs that gate the release', () => {
    expect(publishJob().outputs).toMatchObject({
      declared: githubExpression('steps.declaration.outputs.declared'),
    });
    // Neither value crosses the job boundary: the release job reads `declared`,
    // `sha` and `tag`, and every consumer of the rest reads the step outputs.
    for (const dead of ['version', 'publish']) {
      expect(publishJob().outputs).not.toHaveProperty(dead);
    }
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
});

describe('standards CLI release completion guards', () => {
  it('fails an inherited version whose release never produced its tag', () => {
    const completion = workflowStep(
      publishJob(),
      'Verify the inherited release completed',
    );
    expect(completion.if).toBe("steps.declaration.outputs.declared == 'false'");
    const environment = stepEnvironment(completion);
    expect([...environment.keys()].sort()).toEqual(['VERSION']);
    expect(environment.get('VERSION')).toBe(
      githubExpression('steps.declaration.outputs.version'),
    );
    // The guard has to fail on a MISSING tag, so the negation is the assertion:
    // without it the sense inverts and stranded releases sail through.
    expect(completion.run).toContain(
      'if ! git rev-parse -q --verify "refs/tags/v$VERSION"',
    );
    expect(completion.run).toContain('exit 1');
  });

  it('fails a withdrawal whose withdrawn release never produced its tag', () => {
    const withdrawal = workflowStep(
      publishJob(),
      'Verify the withdrawn release completed',
    );
    expect(withdrawal.if).toBe(
      "steps.declaration.outputs.withdrawn_version != ''",
    );
    const environment = stepEnvironment(withdrawal);
    expect([...environment.keys()].sort()).toEqual(['WITHDRAWN_VERSION']);
    expect(environment.get('WITHDRAWN_VERSION')).toBe(
      githubExpression('steps.declaration.outputs.withdrawn_version'),
    );
    // The version at risk is the one being abandoned, not the one reverted to.
    expect(withdrawal.run).toContain(
      'if ! git rev-parse -q --verify "refs/tags/v$WITHDRAWN_VERSION"',
    );
    expect(withdrawal.run).toContain('npm registry');
    // Hand-tagging would skip provenance verification and leave no Release, so
    // the message routes to the run that performs both.
    expect(withdrawal.run).toContain(
      're-run the failed Publish standards CLI run',
    );
    expect(withdrawal.run).toContain('exit 1');
  });

  it('refuses to publish once main advanced past the declaring commit', () => {
    const tip = workflowStep(
      publishJob(),
      'Verify the declaring commit is still the tip of main',
    );
    // The property protected is a precondition of publishing, not of declaring:
    // a run that only recovers provenance must not be failed by it.
    expect(tip.if).toBe("steps.release.outputs.publish == 'true'");
    const names = workflowStepNames(publishJob());
    const tipIndex = names.indexOf(
      'Verify the declaring commit is still the tip of main',
    );
    // It reads `steps.release.outputs.publish`, so it has to follow the step
    // that writes it; it is a cheap precondition of the pack and the publish, so
    // it has to precede both — the publish is what an incoherent attestation
    // would come from, the pack is the work a doomed run should not spend.
    expect(names.indexOf('Determine release state')).toBeLessThan(tipIndex);
    for (const guarded of ['Pack and inspect package', 'Publish package']) {
      expect(tipIndex).toBeLessThan(names.indexOf(guarded));
    }
    const environment = stepEnvironment(tip);
    expect([...environment.keys()].sort()).toEqual([
      'PROVENANCE_SHA',
      'RELEASE_SHA',
    ]);
    expect(environment.get('PROVENANCE_SHA')).toBe(
      githubExpression('github.sha'),
    );
    expect(environment.get('RELEASE_SHA')).toBe(
      githubExpression('github.event.workflow_run.head_sha'),
    );
    expect(tip.run).toContain('"$PROVENANCE_SHA" != "$RELEASE_SHA"');
    expect(tip.run).toContain('exit 1');
  });
});
