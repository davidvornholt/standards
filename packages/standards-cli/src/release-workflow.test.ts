import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const workflow = readFileSync(
  join(import.meta.dir, '../../../.github/workflows/publish-standards-cli.yml'),
  'utf8',
);

const position = (text: string): number => workflow.indexOf(text);

describe('CLI release workflow', () => {
  it('packs the tested commit before npm and GitHub mutation decisions', () => {
    const pack = position('- name: Pack and inspect package');
    const npm = position('- name: Inspect npm release boundary');
    const github = position('- name: Preflight GitHub release boundary');
    const publish = position('- name: Publish package');
    expect([pack, npm, github, publish]).not.toContain(-1);
    expect(pack).toBeLessThan(npm);
    expect(npm).toBeLessThan(github);
    expect(github).toBeLessThan(publish);
    expect(workflow).toContain('npm "$GITHUB_OUTPUT" "$PACKAGE_NAME"');
    expect(workflow).toContain('github-inspect');
  });

  it('represents a missing parent without making git show fatal', () => {
    expect(workflow).toContain(
      'if git cat-file -e "$RELEASE_SHA^:$PACKAGE_PATH" 2>/dev/null; then',
    );
    expect(workflow).toContain(
      'classify "$GITHUB_OUTPUT" "$version" "$parent_version"',
    );
  });

  it('uses the tested helper for fail-closed GitHub reconciliation', () => {
    expect(workflow).toContain('github-reconcile');
    expect(workflow).not.toContain('gh release create');
    expect(workflow).not.toContain('git ls-remote');
    const releaseJob = position('  release:');
    expect(releaseJob).toBeGreaterThan(-1);
    const setupBun = workflow.indexOf('- name: Setup Bun', releaseJob);
    const reconcile = workflow.indexOf(
      '- name: Reconcile verified GitHub tag and release',
      releaseJob,
    );
    expect(setupBun).toBeGreaterThan(releaseJob);
    expect(reconcile).toBeGreaterThan(setupBun);
  });
});
