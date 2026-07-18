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
  JSON.stringify({ ci: { standards_sync_token: value } });

type FallbackScenario = {
  readonly label: string;
  readonly options: SopsActionOptions;
  readonly curlCalled: boolean;
  readonly sopsExecuted: boolean;
};

const FALLBACK_SCENARIOS: ReadonlyArray<FallbackScenario> = [
  {
    label: 'the age key is not configured',
    options: { ageKey: '' },
    curlCalled: false,
    sopsExecuted: false,
  },
  {
    label: 'the secret file does not exist',
    options: { createSecretFile: false },
    curlCalled: false,
    sopsExecuted: false,
  },
  {
    label: 'the runner architecture has no pinned binary',
    options: { unameMachine: 'riscv64' },
    curlCalled: false,
    sopsExecuted: false,
  },
  {
    label: 'the SOPS download fails',
    options: { curlStatus: 22 },
    curlCalled: true,
    sopsExecuted: false,
  },
  {
    label: 'the downloaded binary fails checksum verification',
    options: { sha256Status: 1 },
    curlCalled: true,
    sopsExecuted: false,
  },
  {
    label: 'decryption fails',
    options: { sopsStatus: 1 },
    curlCalled: true,
    sopsExecuted: true,
  },
  {
    label: 'the requested key is absent',
    options: { sopsOutput: ciValue(undefined) },
    curlCalled: true,
    sopsExecuted: true,
  },
  {
    label: 'the decrypted value is empty',
    options: { sopsOutput: ciValue('') },
    curlCalled: true,
    sopsExecuted: true,
  },
  {
    label: 'the decrypted value is multi-line',
    options: { sopsOutput: ciValue('token\nBASH_ENV=/tmp/payload') },
    curlCalled: true,
    sopsExecuted: true,
  },
  {
    label: 'the decrypted value has a carriage return',
    options: { sopsOutput: ciValue('token\rGH_TOKEN=payload') },
    curlCalled: true,
    sopsExecuted: true,
  },
  {
    label: 'the decrypted value is not a string',
    options: { sopsOutput: ciValue({ token: 'value' }) },
    curlCalled: true,
    sopsExecuted: true,
  },
];

const rows = FALLBACK_SCENARIOS.map(
  (scenario) => [scenario.label, scenario] as const,
);

describe('fallback-eligible failures', () => {
  it.each(rows)('uses the fallback when %s', (_label, scenario) => {
    const actionRun = runSopsAction(scenario.options);

    expect(actionRun.result.status).toBe(0);
    expect(actionRun.environment).toBe('GH_TOKEN=workflow-token\n');
    expect(actionRun.output).toBe('used-fallback=true\n');
    expect(actionRun.result.stdout).toContain('::warning::');
    expect(actionRun.result.stdout).toContain('using the configured fallback');
    expect(actionRun.curlCalled).toBe(scenario.curlCalled);
    expect(actionRun.sopsExecuted).toBe(scenario.sopsExecuted);
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
      '::error::',
    );
    expect(actionRun.sopsExecuted).toBe(scenario.sopsExecuted);
  });

  it.each([
    ['fail'],
    ['fallback'],
  ] as const)('never keeps or executes an unverified binary in %s mode', (failureMode) => {
    const actionRun = runSopsAction({ failureMode, sha256Status: 1 });

    expect(actionRun.sopsExecuted).toBe(false);
    expect(actionRun.sopsBinaryPresent).toBe(false);
  });
});

describe('canonical SOPS secret action', () => {
  it('exports a decrypted non-empty single-line string', () => {
    const actionRun = runSopsAction();

    expect(actionRun.result.status).toBe(0);
    expect(actionRun.environment).toBe('GH_TOKEN=resolved-token\n');
    expect(actionRun.output).toBe('used-fallback=false\n');
    expect(actionRun.result.stdout).toContain('::add-mask::resolved-token');
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

  it.each([
    ['an empty string', ''],
    ['a line-feed string', 'token\nBASH_ENV=/tmp/payload'],
  ] as const)('rejects %s as the fallback value before the environment boundary', (_label, fallbackValue) => {
    const actionRun = runSopsAction({ ageKey: '', fallbackValue });

    expect(actionRun.result.status).toBe(1);
    expect(actionRun.environment).toBe('');
    expect(actionRun.output).toBe('');
  });
});
