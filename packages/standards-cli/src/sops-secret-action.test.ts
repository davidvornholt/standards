// Behavioral matrix for the canonical SOPS secret action: every failure in the
// "secret is unavailable" class fails the step, as do caller configuration
// errors. The action has no mode that substitutes a value for a secret it could
// not resolve, and a guard below keeps one from being reintroduced.

import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { parse as parseYaml } from 'yaml';
import { cleanupTmpDirs, SOPS_ACTION } from './cli-test-support';
import {
  createSopsActionRunner,
  type SopsActionOptions,
} from './sops-secret-action-test-support';

const runSopsAction = createSopsActionRunner(process.env);

afterEach(cleanupTmpDirs);

const ciValue = (value: unknown): string =>
  JSON.stringify({ ci: { example_token: value } });

type UnavailableScenario = {
  readonly label: string;
  readonly options: SopsActionOptions;
  readonly reason: string;
  readonly failsAt: 'setup' | 'install' | 'resolve';
};

const UNAVAILABLE_SCENARIOS: ReadonlyArray<UnavailableScenario> = [
  {
    label: 'the age key is not configured',
    options: { ageKey: '' },
    reason: 'SOPS_AGE_KEY is not configured',
    failsAt: 'setup',
  },
  {
    label: 'the secret file does not exist',
    options: { createSecretFile: false },
    reason: 'secrets/ci.yaml does not exist',
    failsAt: 'setup',
  },
  {
    label: 'the runner architecture has no pinned binary',
    options: { unameMachine: 'riscv64' },
    reason: 'No pinned SOPS binary for runner architecture riscv64',
    failsAt: 'setup',
  },
  {
    label: 'the SOPS download fails',
    options: { curlStatus: 22 },
    reason: 'Downloading SOPS v3.13.2 for linux/amd64 failed',
    failsAt: 'install',
  },
  {
    label: 'the downloaded binary fails checksum verification',
    options: { sha256Status: 1 },
    reason: 'Downloaded SOPS binary does not match the pinned checksum',
    failsAt: 'install',
  },
  {
    label: 'decryption fails',
    options: { sopsStatus: 1 },
    reason: 'Decrypting secrets/ci.yaml with SOPS failed',
    failsAt: 'resolve',
  },
  {
    label: 'the requested key is absent',
    options: { sopsOutput: ciValue(undefined) },
    reason: 'ci.example_token is missing in secrets/ci.yaml',
    failsAt: 'resolve',
  },
  {
    label: 'the decrypted value is empty',
    options: { sopsOutput: ciValue('') },
    reason: 'ci.example_token is empty in secrets/ci.yaml',
    failsAt: 'resolve',
  },
  {
    label: 'the decrypted value is not a string',
    options: { sopsOutput: ciValue({ token: 'value' }) },
    reason: 'ci.example_token is not a string in secrets/ci.yaml',
    failsAt: 'resolve',
  },
];

const rows = UNAVAILABLE_SCENARIOS.map((s) => [s.label, s] as const);

describe('unresolvable secrets', () => {
  it.each(rows)('fails closed when %s', (_label, scenario) => {
    const actionRun = runSopsAction(scenario.options);

    expect(actionRun.result.status).toBe(1);
    expect(actionRun.environment).toBe('');
    expect(actionRun.output).toBe('');
    expect(`${actionRun.result.stdout}${actionRun.result.stderr}`).toContain(
      `::error::${scenario.reason}`,
    );
    expect(actionRun.result.stdout).not.toContain('::warning::');
    expect(actionRun.curlCalled).toBe(scenario.failsAt !== 'setup');
    expect(actionRun.sopsExecuted).toBe(scenario.failsAt === 'resolve');
  });

  it('never keeps or executes an unverified binary', () => {
    const actionRun = runSopsAction({ sha256Status: 1 });

    expect(actionRun.sopsExecuted).toBe(false);
    expect(actionRun.sopsBinaryPresent).toBe(false);
  });
});

describe('canonical SOPS secret action script behavior', () => {
  it('exports a decrypted non-empty single-line string', () => {
    const actionRun = runSopsAction();

    expect(actionRun.result.status).toBe(0);
    expect(actionRun.environment).toBe('GH_TOKEN=resolved-token\n');
    expect(actionRun.output).toBe('');
    expect(actionRun.result.stdout).toBe('::add-mask::resolved-token\n');
    expect(actionRun.result.stderr).toBe('');
    expect(actionRun.curlCalled).toBe(true);
    expect(actionRun.sopsExecuted).toBe(true);
  });

  // The action used to offer a mode that exported a caller-supplied default
  // instead of failing. Its last caller degraded a broken credential into a
  // green gate, so the mode is gone; this pins the contract that resolving is
  // the only outcome an interface can ask for.
  it('offers no interface for substituting an unresolvable secret', () => {
    const action = parseYaml(readFileSync(SOPS_ACTION, 'utf8')) as {
      readonly inputs: Record<string, unknown>;
      readonly outputs?: Record<string, unknown>;
    };

    expect(Object.keys(action.inputs).sort()).toEqual([
      'age-key',
      'env-name',
      'secret-file',
      'secret-key',
    ]);
    expect(action.outputs).toBeUndefined();
  });
});

describe('caller configuration errors', () => {
  it('rejects an env-name that is not a valid variable name', () => {
    const options: SopsActionOptions = { envName: 'GH TOKEN' };
    const actionRun = runSopsAction(options);

    expect(actionRun.result.status).toBe(1);
    expect(actionRun.environment).toBe('');
    expect(actionRun.output).toBe('');
    expect(`${actionRun.result.stdout}${actionRun.result.stderr}`).toContain(
      '::error::env-name must be a valid environment variable name',
    );
    // Rejected before any network or decrypt work happens.
    expect(actionRun.curlCalled).toBe(false);
    expect(actionRun.sopsExecuted).toBe(false);
  });
});
