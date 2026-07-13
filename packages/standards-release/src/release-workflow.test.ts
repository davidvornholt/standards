import { describe, expect, it } from 'bun:test';
import { file } from './release-runtime';

const workflow = await file(
  `${import.meta.dir}/../../../.github/workflows/publish-standards-cli.yml`,
).text();

const position = (text: string): number => workflow.indexOf(text);

describe('CLI release workflow', () => {
  it('classifies before install and gates release work on the declaration', () => {
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
    expect(install).toBeLessThan(pack);
    expect(pack).toBeLessThan(npm);
    expect(npm).toBeLessThan(github);
    expect(github).toBeLessThan(publish);
    expect(workflow).toContain('npm "$GITHUB_OUTPUT" "$PACKAGE_NAME"');
    expect(workflow).toContain('github-inspect');
    expect(workflow).toContain(
      "if: steps.declaration.outputs.declared == 'true'",
    );
    expect(workflow).toContain('run: bun install --frozen-lockfile');
    expect(workflow).toContain(
      'bun run --cwd packages/standards-release release:classify',
    );
  });

  it('represents a missing parent without making git show fatal', () => {
    expect(workflow).toContain(
      'if git cat-file -e "$RELEASE_SHA^:$PACKAGE_PATH" 2>/dev/null; then',
    );
    expect(workflow).toContain('"$GITHUB_OUTPUT" "$version" "$parent_version"');
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
});
