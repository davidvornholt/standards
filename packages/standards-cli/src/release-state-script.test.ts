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

  it('plans initial publication with an explicit missing parent', () => {
    expect(run(['plan', '$OUTPUT', '0.1.0', '', '', 'false'])).toEqual({
      exitCode: 0,
      output: 'publish=true\nreconcile=true\n',
      stderr: '',
    });
  });

  it('writes reconciliation output and reports conflicts', () => {
    expect(run(['reconcile', '$OUTPUT', 'expected', 'absent', ''])).toEqual({
      exitCode: 0,
      output: 'action=create\n',
      stderr: '',
    });
    const conflict = run([
      'reconcile',
      '$OUTPUT',
      'expected',
      'absent',
      'other',
    ]);
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stderr).toContain(
      '::error::Release tag points to other, expected expected',
    );
  });

  it('fails on invalid arguments and unsupported commands', () => {
    const invalidBoolean = run([
      'plan',
      '$OUTPUT',
      '0.5.0',
      '0.4.0',
      '0.4.0',
      'maybe',
    ]);
    expect(invalidBoolean.exitCode).toBe(1);
    expect(invalidBoolean.stderr).toContain(
      '::error::npm version existence must be true or false',
    );
    const unsupported = run(['unknown']);
    expect(unsupported.exitCode).toBe(1);
    expect(unsupported.stderr).toContain(
      '::error::Expected release-state command',
    );
  });
});
