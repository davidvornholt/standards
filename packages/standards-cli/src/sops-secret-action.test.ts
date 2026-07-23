// Behavioral matrix for the canonical SOPS secret action: every failure in
// the "secret is unavailable" class honors failure-mode, while caller
// configuration errors and invalid final values stay fail-closed in both.

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

const FINAL_VALUE_ERROR = '::error::Resolved secret value must be non-empty';

type FallbackScenario = {
  readonly label: string;
  readonly options: SopsActionOptions;
  readonly reason: string;
  readonly failsAt: 'setup' | 'install' | 'resolve';
};

const FALLBACK_SCENARIOS: ReadonlyArray<FallbackScenario> = [
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

const rows = FALLBACK_SCENARIOS.map((s) => [s.label, s] as const);

describe('fallback-eligible failures', () => {
  it.each(rows)('uses the fallback when %s', (_label, scenario) => {
    const actionRun = runSopsAction(scenario.options);

    expect(actionRun.result.status).toBe(0);
    expect(actionRun.environment).toBe('GH_TOKEN=workflow-token\n');
    expect(actionRun.output).toBe('used-fallback=true\n');
    expect(actionRun.result.stdout).toContain(
      `::warning::${scenario.reason}; using the configured fallback`,
    );
    expect(actionRun.curlCalled).toBe(scenario.failsAt !== 'setup');
    expect(actionRun.sopsExecuted).toBe(scenario.failsAt === 'resolve');
  });

  it.each(rows)('fails closed in fail mode when %s', (_label, scenario) => {
    const actionRun = runSopsAction({
      ...scenario.options,
      failureMode: 'fail',
    });

    expect(actionRun.result.status).toBe(1);
    expect(actionRun.environment).toBe('');
    expect(actionRun.output).toBe('');
    expect(`${actionRun.result.stdout}${actionRun.result.stderr}`).toContain(
      `::error::${scenario.reason}`,
    );
    expect(actionRun.curlCalled).toBe(scenario.failsAt !== 'setup');
    expect(actionRun.sopsExecuted).toBe(scenario.failsAt === 'resolve');
  });

  it.each([
    'fail',
    'fallback',
  ] as const)('never keeps or executes an unverified binary in %s mode', (failureMode) => {
    const actionRun = runSopsAction({ failureMode, sha256Status: 1 });

    expect(actionRun.sopsExecuted).toBe(false);
    expect(actionRun.sopsBinaryPresent).toBe(false);
  });
});

describe('canonical SOPS secret action script behavior', () => {
  it('exports a decrypted non-empty single-line string', () => {
    const actionRun = runSopsAction();

    expect(actionRun.result.status).toBe(0);
    expect(actionRun.environment).toBe('GH_TOKEN=resolved-token\n');
    expect(actionRun.output).toBe('used-fallback=false\n');
    expect(actionRun.result.stdout).toBe('::add-mask::resolved-token\n');
    expect(actionRun.result.stderr).toBe('');
    expect(actionRun.curlCalled).toBe(true);
    expect(actionRun.sopsExecuted).toBe(true);
  });

  it('defaults failure-mode to fail', () => {
    const action = parseYaml(readFileSync(SOPS_ACTION, 'utf8')) as {
      readonly inputs: Record<string, { readonly default?: string }>;
    };

    expect(action.inputs['failure-mode'].default).toBe('fail');
  });
});

describe('caller configuration errors', () => {
  it.each([
    ['env-name is not a valid variable name', { envName: 'GH TOKEN' }],
    ['failure-mode is not a supported mode', { failureMode: 'warn' }],
  ] as ReadonlyArray<
    readonly [string, SopsActionOptions]
  >)('fails closed even with a usable fallback when %s', (_label, options) => {
    const actionRun = runSopsAction({ ageKey: '', ...options });

    expect(actionRun.result.status).toBe(1);
    expect(actionRun.environment).toBe('');
    expect(actionRun.output).toBe('');
    expect(`${actionRun.result.stdout}${actionRun.result.stderr}`).toContain(
      '::error::',
    );
  });

  it('rejects an empty fallback value before the environment boundary', () => {
    const actionRun = runSopsAction({ ageKey: '', fallbackValue: '' });

    expect(actionRun.result.status).toBe(1);
    expect(actionRun.environment).toBe('');
    expect(actionRun.output).toBe('');
    expect(`${actionRun.result.stdout}${actionRun.result.stderr}`).toContain(
      FINAL_VALUE_ERROR,
    );
  });
});
