import { describe, expect, it } from 'bun:test';
import { file } from './release-runtime';

const workflow = await file(
  `${import.meta.dir}/../../../.github/workflows/publish-standards-cli.yml`,
).text();
const classifier = await file(
  `${import.meta.dir}/../scripts/classify-release.ts`,
).text();
const agentContract = await file(
  `${import.meta.dir}/../../../AGENTS.md`,
).text();
const localAgentContract = await file(
  `${import.meta.dir}/../../../AGENTS.local.md`,
).text();
const ABSOLUTE_PACKAGE_PATH =
  /PACKAGE_PATH: \$\{\{ github\.workspace \}\}\/packages\/standards-cli/u;
const TESTED_SHA_CHECKOUT =
  /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/u;
const githubExpression = (value: string): string => `$${`{{ ${value} }}`}`;
const NPM_RELEASE_SHA = `RELEASE_SHA: ${githubExpression('steps.npm.outputs.release_sha')}`;
const RELEASE_JOB_SHA = `RELEASE_SHA: ${githubExpression('needs.publish.outputs.release_sha')}`;
const RELEASE_TOOL_CHECKOUT = `ref: ${githubExpression('needs.publish.outputs.tool_sha')}`;

const position = (text: string): number => workflow.indexOf(text);

describe('source-only Effect exception', () => {
  it('keeps release classification out of the canonical consumer contract', () => {
    expect(agentContract).not.toContain('packages/standards-release');
    expect(localAgentContract).toContain(
      '`packages/standards-release/scripts/classify-release.ts` executable and its dependency-free helper closure',
    );
    expect(localAgentContract).toContain(
      'GitHub Release reconciliation, follows the Effect and tagged-error rules',
    );
  });
});

describe('CLI release workflow authorization', () => {
  it('rejects a same-named quality workflow at a different path', () => {
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
      "github.event.workflow_run.head_branch == 'main'",
    );
    expect(publishGuard).toContain(
      'github.event.workflow_run.head_repository.full_name == github.repository',
    );
    expect(publishGuard).not.toContain('github.event.workflow_run.name');
    expect(workflow).toMatch(TESTED_SHA_CHECKOUT);
  });
});

describe('CLI release workflow', () => {
  it('validates cheaply before authoritative npm inspection', () => {
    const declaration = position('- name: Determine release declaration');
    const install = position('- name: Install release tooling');
    const pack = position('- name: Pack and inspect package');
    const npm = position('- name: Inspect npm release boundary');
    const github = position('- name: Preflight GitHub release boundary');
    const publish = position('- name: Publish package');
    expect([declaration, install, pack, npm, github, publish]).not.toContain(
      -1,
    );
    expect(declaration).toBeLessThan(install);
    expect(install).toBeLessThan(npm);
    expect(npm).toBeLessThan(pack);
    expect(pack).toBeLessThan(github);
    expect(github).toBeLessThan(publish);
    expect(workflow).toContain(
      'npm "$GITHUB_OUTPUT" "$PACKAGE_NAME" "$RELEASE_VERSION"',
    );
    expect(workflow).toContain('github-inspect');
    expect(workflow).not.toContain(
      "if: steps.declaration.outputs.declared == 'true'",
    );
    expect(workflow).toContain('run: bun install --frozen-lockfile');
    expect(workflow).toContain(
      'bun run --cwd packages/standards-release release:classify',
    );
    expect(workflow).toContain(
      '.devDependencies[$name] | select(type == "string")',
    );
    expect(workflow).toContain('ROOT_PACKAGE_PATH: package.json');
    expect(workflow).toContain('"$root_version" != "$version"');
    expect(workflow).toContain('"$template_version" != "$version"');
    expect(workflow).toContain(
      'pack "$GITHUB_OUTPUT" "$PACKAGE_PATH" "$artifact_dir" "$RELEASE_SHA"',
    );
    expect(workflow).toMatch(ABSOLUTE_PACKAGE_PATH);
    expect(classifier).not.toContain('release-effect');
    expect(classifier).not.toContain("from 'effect");
  });

  it('does not let first-parent state gate npm inspection', () => {
    expect(workflow).not.toContain('parent_version');
    expect(workflow).not.toContain('$RELEASE_SHA^:');
    expect(workflow).toContain('"$GITHUB_OUTPUT" "$version"');
  });
});

describe('CLI release workflow recovery', () => {
  it('recovers from coalesced runs through npm artifact identity', () => {
    const npm = position('- name: Inspect npm release boundary');
    const pack = position('- name: Pack and inspect package');
    expect(npm).toBeLessThan(pack);
    expect(workflow).toContain("if: steps.npm.outputs.publish == 'true'");
    expect(workflow).toContain(NPM_RELEASE_SHA);
    expect(workflow).toContain(
      '"$CURRENT_SHA" "$GITHUB_WORKSPACE" "$RUNNER_TEMP"',
    );
    expect(workflow).not.toContain(
      '- name: Verify release commit is in tested history',
    );
  });

  it('serializes every pending publish run without job-name authorization', () => {
    expect(workflow).toContain('group: publish-standards-cli\n  queue: max');
    expect(workflow).not.toContain('cancel-in-progress:');
    expect(workflow).not.toContain('github.event.workflow_run.name');
  });

  it('pins the release artifact format to Bun 1.3.14', () => {
    expect(workflow.match(/bun-version: 1\.3\.14/gu)).toHaveLength(2);
  });

  it('uses the tested helper for fail-closed GitHub reconciliation', () => {
    expect(workflow).toContain('github-reconcile');
    expect(workflow).not.toContain('gh release create');
    expect(workflow).not.toContain('git ls-remote');
    const releaseJob = position('  release:');
    expect(releaseJob).toBeGreaterThan(-1);
    const setupBun = workflow.indexOf('- name: Setup Bun', releaseJob);
    const install = workflow.indexOf(
      '- name: Install release tooling',
      releaseJob,
    );
    const reconcile = workflow.indexOf(
      '- name: Reconcile verified GitHub tag and release',
      releaseJob,
    );
    expect(setupBun).toBeGreaterThan(releaseJob);
    expect(install).toBeGreaterThan(setupBun);
    expect(reconcile).toBeGreaterThan(install);
    expect(workflow).toContain(
      'bun run --cwd packages/standards-release release:state',
    );
  });

  it('keeps push-visible draft preflight in the publishing job', () => {
    const publishJob = workflow.slice(
      position('  publish:'),
      position('  release:'),
    );
    expect(publishJob).toContain('contents: write');
    expect(publishJob).toContain('id-token: write');
    const preflight = position('- name: Preflight GitHub release boundary');
    const publish = position('- name: Publish package');
    expect(preflight).toBeGreaterThan(position('  publish:'));
    expect(preflight).toBeLessThan(position('  release:'));
    expect(preflight).toBeLessThan(publish);
  });

  it('exports only values consumed by the release job', () => {
    const outputs = workflow.slice(
      position('    outputs:'),
      position('    steps:'),
    );
    expect(outputs).toContain('reconcile:');
    expect(outputs).toContain('tag:');
    expect(outputs).toContain('release_sha:');
    expect(outputs).toContain('tool_sha:');
    expect(outputs).not.toContain('publish:');
    expect(outputs).not.toContain('version:');
    expect(workflow).toContain(RELEASE_TOOL_CHECKOUT);
    expect(workflow).toContain(RELEASE_JOB_SHA);
  });
});
