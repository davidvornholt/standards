import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'bun';

const packageRoot = join(import.meta.dir, '..');
const directories: Array<string> = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const run = (args: ReadonlyArray<string>) => {
  const directory = mkdtempSync(join(tmpdir(), 'release-state-script-'));
  directories.push(directory);
  const output = join(directory, 'output');
  const result = spawnSync(
    [
      'bun',
      'scripts/release-state.ts',
      ...args.map((arg) => (arg === '$OUTPUT' ? output : arg)),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  return {
    exitCode: result.exitCode,
    output: result.exitCode === 0 ? readFileSync(output, 'utf8') : '',
    stderr: result.stderr.toString(),
  };
};

describe('release-state workflow wrapper', () => {
  it('classifies declarations and writes stable workflow outputs', () => {
    expect(run(['classify', '$OUTPUT', '0.5.0', '0.4.0'])).toEqual({
      exitCode: 0,
      output: 'declared=true\ntag=v0.5.0\nversion=0.5.0\n',
      stderr: '',
    });
    expect(run(['classify', '$OUTPUT', '0.5.0', '0.5.0'])).toEqual({
      exitCode: 0,
      output: 'declared=false\ntag=v0.5.0\nversion=0.5.0\n',
      stderr: '',
    });
  });

  it('surfaces tagged validation and argument failures', () => {
    const invalidVersion = run([
      'classify',
      '$OUTPUT',
      'not-semver',
      'not-semver',
    ]);
    expect(invalidVersion.exitCode).toBe(1);
    expect(invalidVersion.stderr).toContain(
      '::error::Version not-semver must be a stable SemVer',
    );
    const missingOutput = run(['classify', '', '0.5.0', '0.4.0']);
    expect(missingOutput.exitCode).toBe(1);
    expect(missingOutput.stderr).toContain(
      '::error::GitHub output path is required',
    );
  });

  it('rejects an unknown command', () => {
    const result = run(['unknown']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      '::error::Expected release-state command classify, npm, github-inspect, or github-reconcile',
    );
  });
});
