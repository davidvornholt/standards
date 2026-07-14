import { describe, expect, it } from 'bun:test';
import { file } from './release-runtime';

const workflow = await file(
  `${import.meta.dir}/../../../.github/workflows/publish-standards-cli.yml`,
).text();
const qualityWorkflow = await file(
  `${import.meta.dir}/../../../.github/workflows/standards.yml`,
).text();
const TESTED_SHA_CHECKOUT =
  /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/u;
const DEFAULT_BRANCH_IDENTITY = 'github.event.repository.default_branch';
const githubExpression = (value: string): string => `$${`{{ ${value} }}`}`;
const position = (text: string): number => workflow.indexOf(text);

describe('CLI release workflow authorization', () => {
  it('authorizes a quality run before shared publish queue admission', () => {
    const workflowHeader = workflow.slice(0, position('jobs:'));
    const publishGuard = workflow.slice(
      position('  publish:'),
      position('    runs-on:'),
    );
    expect(publishGuard).toContain(
      "github.event.workflow_run.path == '.github/workflows/standards.yml'",
    );
    expect(publishGuard).toContain(
      "github.event.workflow_run.conclusion == 'success'",
    );
    expect(publishGuard).toContain("github.event.workflow_run.event == 'push'");
    expect(publishGuard).toContain(
      `github.event.workflow_run.head_branch == ${DEFAULT_BRANCH_IDENTITY}`,
    );
    expect(publishGuard).toContain(
      'github.event.workflow_run.head_repository.full_name == github.repository',
    );
    expect(publishGuard).not.toContain('github.event.workflow_run.name');
    expect(workflowHeader).not.toContain('concurrency:');
    expect(publishGuard).toContain(
      'concurrency:\n      group: publish-standards-cli\n      queue: max',
    );
    expect(publishGuard.indexOf('if:')).toBeLessThan(
      publishGuard.indexOf('concurrency:'),
    );
    expect(workflow).toMatch(TESTED_SHA_CHECKOUT);
    expect(qualityWorkflow).toContain(
      `github.ref_name == ${DEFAULT_BRANCH_IDENTITY}`,
    );
    expect(workflow).not.toContain('DEFAULT_BRANCH:');
    expect(workflow).not.toContain('git merge-base --is-ancestor');
    expect(workflow).not.toContain("head_branch == 'main'");
    expect(workflow).not.toContain('origin/main');
  });

  it('freshly authorizes both mutation paths through tested release tooling', () => {
    expect(workflow.match(/github-authorize "\$RELEASE_SHA"/gu)).toHaveLength(
      2,
    );
    const publishAuthorization = workflow.slice(
      position('- name: Authorize release SHA on the live default branch'),
      position('- name: Publish package'),
    );
    expect(publishAuthorization).toContain(
      `RELEASE_SHA: ${githubExpression('steps.npm.outputs.release_sha')}`,
    );
    const releaseJob = position('  release:');
    const releaseAuthorization = workflow.slice(
      workflow.indexOf(
        '- name: Authorize release SHA on the live default branch',
        releaseJob,
      ),
      position('- name: Reconcile verified GitHub tag and release'),
    );
    expect(releaseAuthorization).toContain(
      `RELEASE_SHA: ${githubExpression('needs.publish.outputs.release_sha')}`,
    );
  });
});
