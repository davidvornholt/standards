import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  publishWorkflowJobs,
  workflowStep,
} from './publish-workflow-test-support';

const SHA = '1234567890abcdef1234567890abcdef12345678';
const RECOVERY_SCRIPT = join(import.meta.dir, '../scripts/release-recovery.ts');
const RECOVERY_MODULE = join(import.meta.dir, 'release-recovery.ts');
const NODE_INVOCATION =
  /node \\\s+packages\/standards-cli\/scripts\/release-recovery\.ts/u;

// The publish workflow runs this dispatcher before `bun install`, so the tree it
// runs from carries the two source files and nothing else. A dependency that
// leaks into the startup path fails here rather than in a release.
const runInSourceOnlyTree = (
  runtime: 'bun' | 'node',
  command: ReadonlyArray<string>,
) => {
  const root = mkdtempSync(join(tmpdir(), 'release-dispatcher-source-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'src'));
    copyFileSync(RECOVERY_SCRIPT, join(root, 'scripts/release-recovery.ts'));
    copyFileSync(RECOVERY_MODULE, join(root, 'src/release-recovery.ts'));
    if (existsSync(join(root, 'node_modules'))) {
      throw new Error('Source-only tree must have no installed dependencies');
    }
    return spawnSync(
      runtime,
      [join(root, 'scripts/release-recovery.ts'), ...command],
      { cwd: root, encoding: 'utf8' },
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

describe('dependency-free release dispatcher', () => {
  // Each command is exercised under the runtime the workflow actually gives it.
  // `Setup Bun` is gated on `declared == 'true'` and has not run when the
  // publish job plans, so the planning commands run under node there; only the
  // release job's `github-state` runs under bun.
  it.each([
    {
      command: ['github-state', 'missing', '', SHA],
      expected: 'create\n',
      label: 'GitHub reconciliation',
      runtime: 'bun',
    },
    {
      command: ['npm-state', '0.14.0', '0.13.0', 'false'],
      expected: 'publish\n',
      label: 'npm release planning',
      runtime: 'node',
    },
    {
      command: ['declaration', '0.14.0', '0.13.0'],
      expected: 'declared\n',
      label: 'release declaration planning',
      runtime: 'node',
    },
  ] as const)('runs $label under $runtime from a detached source-only tree', (fixture) => {
    const result = runInSourceOnlyTree(fixture.runtime, fixture.command);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(fixture.expected);
    expect(result.status).toBe(0);
  });

  it('plans the publish job under the runtime that job has available', () => {
    const publishJob = publishWorkflowJobs().publish ?? {};
    for (const [step, command] of [
      ['Determine release declaration', 'declaration'],
      ['Determine release state', 'npm-state'],
    ] as const) {
      const run = workflowStep(publishJob, step).run ?? '';
      expect(run).toMatch(NODE_INVOCATION);
      expect(run).toContain(command);
    }
  });

  it('rejects an unknown command from the source-only tree', () => {
    const result = runInSourceOnlyTree('node', ['release-state']);
    expect(result.stderr).toContain(
      '::error::Expected declaration, provenance, npm-state, or github-state release recovery command',
    );
    expect(result.stdout).toBe('');
    expect(result.status).toBe(1);
  });

  // Argument validation runs ahead of the Sigstore import precisely so this
  // tree — which has no node_modules to import from — reports the usage problem
  // instead of a module-resolution failure. The message carries no
  // `[malformed-provenance]` classifier: that classifier reports on a fetched
  // attestation bundle, and here nothing was ever fetched to malform.
  it('reports a malformed provenance invocation without importing Sigstore', () => {
    const result = runInSourceOnlyTree('node', ['provenance', 'only-a-path']);
    expect(result.stderr).toContain(
      '::error::Provenance verification requires a response path, installed integrity, TUF cache, and complete GitHub release context',
    );
    expect(result.stderr).not.toContain('malformed-provenance');
    expect(result.stderr).not.toContain('Cannot find');
    expect(result.stdout).toBe('');
    expect(result.status).toBe(1);
  });
});
