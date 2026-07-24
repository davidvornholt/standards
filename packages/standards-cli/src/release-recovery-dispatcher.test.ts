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

const SHA = '1234567890abcdef1234567890abcdef12345678';
const RECOVERY_SCRIPT = join(import.meta.dir, '../scripts/release-recovery.ts');
const RECOVERY_MODULE = join(import.meta.dir, 'release-recovery.ts');

// The publish workflow runs this dispatcher before `bun install`, so the tree it
// runs from carries the two source files and nothing else. A dependency that
// leaks into the startup path fails here rather than in a release.
const runInSourceOnlyTree = (command: ReadonlyArray<string>) => {
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
      'bun',
      [join(root, 'scripts/release-recovery.ts'), ...command],
      { cwd: root, encoding: 'utf8' },
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

describe('dependency-free release dispatcher', () => {
  it.each([
    {
      command: ['github-state', 'missing', '', SHA],
      expected: 'create\n',
      label: 'GitHub reconciliation',
    },
    {
      command: ['npm-state', '0.14.0', '0.13.0', 'false'],
      expected: 'publish\n',
      label: 'npm release planning',
    },
    {
      command: ['declaration', '0.14.0', '0.13.0'],
      expected: 'declared\n',
      label: 'release declaration planning',
    },
  ] as const)('runs $label from a detached source-only tree', (fixture) => {
    const result = runInSourceOnlyTree(fixture.command);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(fixture.expected);
    expect(result.status).toBe(0);
  });

  // Argument validation runs ahead of the Sigstore import precisely so this
  // tree — which has no node_modules to import from — reports the usage problem
  // instead of a module-resolution failure. The message carries no
  // `[malformed-provenance]` classifier: that classifier reports on a fetched
  // attestation bundle, and here nothing was ever fetched to malform.
  it('reports a malformed provenance invocation without importing Sigstore', () => {
    const result = runInSourceOnlyTree(['provenance', 'only-a-path']);
    expect(result.stderr).toContain(
      '::error::Provenance verification requires a response path, installed integrity, TUF cache, and complete GitHub release context',
    );
    expect(result.stderr).not.toContain('malformed-provenance');
    expect(result.stderr).not.toContain('Cannot find');
    expect(result.stdout).toBe('');
    expect(result.status).toBe(1);
  });
});
