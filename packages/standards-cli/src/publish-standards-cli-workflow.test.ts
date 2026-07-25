import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  githubExpression,
  publishWorkflowJobs,
  workflowStep,
} from './publish-workflow-test-support';

const PACKAGE_PATH = join(import.meta.dir, '../package.json');

describe('standards CLI publish recovery workflow', () => {
  it('publishes a new version and reconciles its exact tested commit', () => {
    const workflowJobs = publishWorkflowJobs();
    expect(workflowStep(workflowJobs.publish ?? {}, 'Publish package').if).toBe(
      "steps.release.outputs.publish == 'true'",
    );
    expect(workflowJobs.release?.needs).toBe('publish');
    expect(
      workflowStep(workflowJobs.release ?? {}, 'Checkout released commit'),
    ).toMatchObject({
      with: { ref: githubExpression('needs.publish.outputs.sha') },
    });
    expect(
      workflowStep(workflowJobs.publish ?? {}, 'Install release dependencies')
        .run,
    ).toBe('bun install --frozen-lockfile --ignore-scripts');
  });

  it('uses the exact-version-aware release state model', () => {
    const releaseState = workflowStep(
      publishWorkflowJobs().publish ?? {},
      'Determine release state',
    );
    expect(releaseState.run).toContain('.versions[$version] != null');
    expect(releaseState.run).toContain('npm-state');
  });

  it('verifies one fetched bundle and binds it to the installed package before recovery', () => {
    const verification = workflowStep(
      publishWorkflowJobs().publish ?? {},
      'Verify existing package provenance',
    );
    expect(verification.if).toBe("steps.release.outputs.publish == 'false'");
    expect(verification.run).toContain('npm audit signatures');
    expect(verification.run).toContain('.packages[$path].integrity');
    expect(verification.run).toContain('release-recovery.ts');
    expect(verification.run).toContain('provenance \\\n');
    expect(verification.run).toContain('"$attestations_file"');
    expect(verification.run).toContain('"$installed_integrity"');
    expect(verification.run).not.toContain('npm exec');
    expect(verification.run?.match(/npm\/v1\/attestations/gu)).toHaveLength(1);
  });

  it('keeps Sigstore exact, development-only, and outside the published bin', () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')) as {
      readonly devDependencies?: Readonly<Record<string, unknown>>;
      readonly dependencies?: Readonly<Record<string, unknown>>;
      readonly files?: ReadonlyArray<string>;
    };
    expect(manifest.devDependencies?.sigstore).toBe('5.0.0');
    expect(manifest.dependencies?.sigstore).toBeUndefined();
    for (const excluded of [
      'src/release-provenance.ts',
      'src/release-provenance-verification.ts',
      'scripts/release-recovery.ts',
    ]) {
      expect(manifest.files).not.toContain(excluded);
    }
  });

  it('routes existing tag and release states through the tested SHA model', () => {
    const releaseJob = publishWorkflowJobs().release ?? {};
    expect(workflowStep(releaseJob, 'Setup Bun')).toMatchObject({
      uses: 'oven-sh/setup-bun@v2',
      with: { 'bun-version': githubExpression('env.BUN_VERSION') },
    });
    const reconciliation = workflowStep(releaseJob, 'Reconcile GitHub release');
    expect(reconciliation.run).toContain('release_state=published');
    expect(reconciliation.run).toContain('release_state=tag-only');
    expect(reconciliation.run).toContain('release-recovery.ts');
    expect(reconciliation.run).toContain(
      'github-state "$release_state" "$tag_sha"',
    );
    expect(reconciliation.run).toContain(
      'bun packages/standards-cli/scripts/release-recovery.ts',
    );
  });
});
