import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const ROOT = join(import.meta.dir, '../../..');
const PREFLIGHT = join(
  ROOT,
  '.github/actions/standards-sync-preflight/index.mjs',
);
const POLICY_FILE = 'sync-standards.local.json';
const STANDARDS_PACKAGE = '@davidvornholt/standards';
const FULL_SHA_LENGTH = 40;

type RunResult = {
  readonly output: string;
  readonly status: number;
  readonly stderr: string;
  readonly stdout: string;
};

const temporaryDirectories: Array<string> = [];

const runPreflight = (
  eventName: 'schedule' | 'workflow_dispatch',
  policyJson: string | undefined,
  version?: string,
): RunResult => {
  const directory = mkdtempSync(join(tmpdir(), 'standards-preflight-'));
  temporaryDirectories.push(directory);
  const outputPath = join(directory, 'github-output');
  if (policyJson !== undefined) {
    writeFileSync(join(directory, POLICY_FILE), policyJson);
  }
  if (version !== undefined) {
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        devDependencies: { [STANDARDS_PACKAGE]: version },
      }),
    );
  }
  const environment = { ...process.env };
  const eventNameVariable = 'GITHUB_EVENT_NAME';
  const outputVariable = 'GITHUB_OUTPUT';
  const workspaceVariable = 'GITHUB_WORKSPACE';
  environment[eventNameVariable] = eventName;
  environment[outputVariable] = outputPath;
  environment[workspaceVariable] = directory;

  const result = spawnSync('node', [PREFLIGHT], {
    cwd: directory,
    encoding: 'utf8',
    env: environment,
  });
  return {
    output: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '',
    status: result.status ?? 1,
    stderr: result.stderr,
    stdout: result.stdout,
  };
};

const serializePolicy = (ref: string, scheduledSync: boolean): string =>
  JSON.stringify({ ref, scheduledSync });

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('scheduled sync preflight', () => {
  it('disables a scheduled run before dependency setup when policy opts out', () => {
    const result = runPreflight(
      'schedule',
      serializePolicy('refs/heads/main', false),
      '0.5.0',
    );

    expect(result.status).toBe(0);
    expect(result.output).toBe('run_sync=false\n');
    expect(result.stdout).toContain('scheduled sync disabled');
  });

  it('enables scheduled runs for default policy without requiring a new CLI', () => {
    const configured = runPreflight(
      'schedule',
      serializePolicy('refs/heads/main', true),
    );
    const missing = runPreflight('schedule', undefined);

    expect(configured.output).toBe('run_sync=true\n');
    expect(missing.output).toBe('run_sync=true\n');
  });

  it('accepts a non-default ref with an exact compatible CLI', () => {
    for (const ref of ['refs/tags/v0.5.0', 'a'.repeat(FULL_SHA_LENGTH)]) {
      const result = runPreflight(
        'schedule',
        serializePolicy(ref, true),
        '0.5.0',
      );
      expect(result.status).toBe(0);
      expect(result.output).toBe('run_sync=true\n');
    }
  });

  it('keeps manual dispatch enabled when scheduled runs are disabled', () => {
    const result = runPreflight(
      'workflow_dispatch',
      serializePolicy('refs/heads/main', false),
      '0.5.0',
    );

    expect(result.status).toBe(0);
    expect(result.output).toBe('run_sync=true\n');
  });

  it('fails before run selection for an old or unverifiable CLI', () => {
    for (const [eventName, version] of [
      ['schedule', '0.4.0'],
      ['workflow_dispatch', '^0.5.0'],
      ['schedule', undefined],
    ] as const) {
      const result = runPreflight(
        eventName,
        serializePolicy('refs/tags/v0.5.0', true),
        version,
      );
      expect(result.status).not.toBe(0);
      expect(result.output).toBe('');
      expect(result.stderr).toContain('exact stable version >=0.5.0');
    }
  });

  it('fails closed on malformed or incomplete policy', () => {
    for (const invalidPolicy of [
      'not json',
      '{}',
      serializePolicy('main', true),
      serializePolicy('refs/heads/bad..ref', true),
      JSON.stringify({ ref: 'refs/heads/main' }),
      JSON.stringify({ ref: 'refs/heads/main', scheduledSync: 'false' }),
    ]) {
      const result = runPreflight('schedule', invalidPolicy);
      expect(result.status).not.toBe(0);
      expect(result.output).toBe('');
      expect(result.stderr.length).toBeGreaterThan(0);
    }
  });
});
