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
import { DEFAULT_SYNC_POLICY, SYNC_POLICY_FILE } from './sync-policy';

const ROOT = join(import.meta.dir, '../../..');
const PREFLIGHT = join(
  ROOT,
  '.github/actions/standards-sync-preflight/index.mjs',
);
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
  eventName: 'repository_dispatch' | 'schedule' | 'workflow_dispatch',
  policyJson: string | undefined,
  packageJson?: string,
): RunResult => {
  const directory = mkdtempSync(join(tmpdir(), 'standards-preflight-'));
  temporaryDirectories.push(directory);
  const outputPath = join(directory, 'github-output');
  if (policyJson !== undefined) {
    writeFileSync(join(directory, SYNC_POLICY_FILE), policyJson);
  }
  if (packageJson !== undefined) {
    writeFileSync(join(directory, 'package.json'), packageJson);
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
const packageWithStandards = (version: string): string =>
  JSON.stringify({ devDependencies: { [STANDARDS_PACKAGE]: version } });
const DEFAULT_POLICY_TEXT = JSON.stringify(DEFAULT_SYNC_POLICY);

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
      serializePolicy(DEFAULT_SYNC_POLICY.ref, false),
      packageWithStandards('0.5.0'),
    );

    expect(result.status).toBe(0);
    expect(result.output).toBe('run_sync=false\n');
    expect(result.stdout).toContain('scheduled sync disabled');
    const unsupported = runPreflight(
      'workflow_dispatch',
      undefined,
      packageWithStandards('0.5.0'),
    );
    expect(unsupported.stderr).toContain('Unsupported Standards sync event');
  });

  it('enables default policy with a compatible direct standards version', () => {
    const configured = runPreflight(
      'schedule',
      DEFAULT_POLICY_TEXT,
      packageWithStandards('0.5.0'),
    );
    const missing = runPreflight(
      'schedule',
      undefined,
      packageWithStandards('0.5.0'),
    );

    expect(configured.output).toBe('run_sync=true\n');
    expect(missing.output).toBe('run_sync=true\n');
  });

  it('accepts a non-default ref with an exact compatible CLI', () => {
    for (const ref of ['refs/tags/v0.5.0', 'a'.repeat(FULL_SHA_LENGTH)]) {
      const result = runPreflight(
        'schedule',
        serializePolicy(ref, true),
        packageWithStandards('0.5.0'),
      );
      expect(result.status).toBe(0);
      expect(result.output).toBe('run_sync=true\n');
    }
  });

  it('keeps default-branch repository dispatch enabled when scheduled runs are disabled', () => {
    const result = runPreflight(
      'repository_dispatch',
      serializePolicy(DEFAULT_SYNC_POLICY.ref, false),
      packageWithStandards('0.5.0'),
    );

    expect(result.status).toBe(0);
    expect(result.output).toBe('run_sync=true\n');
  });

  it('fails before run selection for an old or unverifiable CLI', () => {
    for (const [eventName, version] of [
      ['schedule', '0.4.0'],
      ['repository_dispatch', '^0.5.0'],
      ['schedule', undefined],
    ] as const) {
      const result = runPreflight(
        eventName,
        serializePolicy('refs/tags/v0.5.0', true),
        version === undefined ? undefined : packageWithStandards(version),
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
      JSON.stringify({ ref: DEFAULT_SYNC_POLICY.ref }),
      JSON.stringify({ ref: DEFAULT_SYNC_POLICY.ref, scheduledSync: 'false' }),
    ]) {
      const result = runPreflight('schedule', invalidPolicy);
      expect(result.status).not.toBe(0);
      expect(result.output).toBe('');
    }

    const aggregated = runPreflight(
      'schedule',
      JSON.stringify({ ref: 'refs/tags/v0.5.0', typo: true }),
      packageWithStandards('0.4.0'),
    );
    expect(aggregated.stderr).toContain('requires boolean "scheduledSync"');
    expect(aggregated.stderr).toContain('exact stable version >=0.5.0');
    expect(aggregated.stderr).toContain('has unknown key "typo"');
  });
});

describe('scheduled sync package preflight', () => {
  it('requires an exact compatible direct standards dependency before run selection', () => {
    for (const packageJson of [
      undefined,
      'not json',
      '{}',
      packageWithStandards('0.4.0'),
      JSON.stringify({ dependencies: { [STANDARDS_PACKAGE]: '0.5.0' } }),
    ]) {
      const result = runPreflight('schedule', DEFAULT_POLICY_TEXT, packageJson);
      expect(result.status).not.toBe(0);
      expect(result.output).toBe('');
      expect(result.stderr).toContain('package.json');
    }
  });
});
