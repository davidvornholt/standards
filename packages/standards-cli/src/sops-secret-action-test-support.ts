// PATH-shim harness that extracts the canonical SOPS action's embedded script
// from the YAML and runs it under bash, so suites can drive every setup and
// decrypt outcome deterministically without network access or a real runner.

import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  mkTmp,
  type RunResult,
  runProcess,
  SOPS_ACTION,
  write,
  yamlRunScript,
} from './cli-test-support';

const EXECUTABLE_MODE = 0o755;

export type SopsActionOptions = {
  readonly ageKey?: string;
  readonly createSecretFile?: boolean;
  readonly curlStatus?: number;
  readonly envName?: string;
  // Deliberately unconstrained so suites can exercise invalid modes.
  readonly failureMode?: string;
  readonly fallbackValue?: string;
  readonly secretKey?: string;
  readonly sha256Status?: number;
  readonly sopsOutput?: string;
  readonly sopsStatus?: number;
  readonly unameMachine?: string;
};

export type SopsActionRun = {
  readonly curlCalled: boolean;
  readonly environment: string;
  readonly output: string;
  readonly result: RunResult;
  readonly sopsBinaryPresent: boolean;
  readonly sopsExecuted: boolean;
};

const shim = (fixture: string, rel: string, lines: ReadonlyArray<string>) => {
  write(fixture, rel, [...lines, ''].join('\n'));
  chmodSync(join(fixture, rel), EXECUTABLE_MODE);
};

const DEFAULT_OPTIONS = {
  ageKey: 'age-secret-key',
  createSecretFile: true,
  curlStatus: 0,
  envName: 'GH_TOKEN',
  failureMode: 'fallback',
  fallbackValue: 'workflow-token',
  secretKey: 'example_token',
  sha256Status: 0,
  sopsOutput: JSON.stringify({
    ci: { example_token: 'resolved-token' },
  }),
  sopsStatus: 0,
  unameMachine: 'x86_64',
} satisfies Required<SopsActionOptions>;

export const createSopsActionRunner =
  (baseEnvironment: Readonly<Record<string, string | undefined>>) =>
  (options: SopsActionOptions = {}): SopsActionRun => {
    const basePath = baseEnvironment.PATH;
    if (basePath === undefined) {
      throw new Error('base environment must define PATH for the shim prefix');
    }
    const resolved = { ...DEFAULT_OPTIONS, ...options };
    const fixture = mkTmp('sops-action-');
    const bin = join(fixture, 'bin');
    const runnerTemp = join(fixture, 'runner');
    mkdirSync(bin);
    mkdirSync(runnerTemp);
    const fakeSops = join(fixture, 'fake-sops');
    const curlMarker = join(fixture, 'curl-called');
    const sopsMarker = join(fixture, 'sops-executed');
    const environmentPath = join(fixture, 'github-env');
    const outputPath = join(fixture, 'github-output');
    shim(fixture, 'bin/uname', [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `printf '%s\\n' "$FAKE_UNAME_MACHINE"`,
    ]);
    shim(fixture, 'bin/curl', [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'printf called > "$CURL_MARKER"',
      'if [ "$FAKE_CURL_STATUS" -ne 0 ]; then',
      '  exit "$FAKE_CURL_STATUS"',
      'fi',
      'cp "$FAKE_SOPS" "$2"',
    ]);
    shim(fixture, 'bin/sha256sum', [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      // Consume the piped checksum line so the writer never sees SIGPIPE.
      'cat > /dev/null',
      'exit "$FAKE_SHA256_STATUS"',
    ]);
    shim(fixture, 'fake-sops', [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'printf executed > "$SOPS_MARKER"',
      'if [ "$FAKE_SOPS_STATUS" -ne 0 ]; then',
      '  exit "$FAKE_SOPS_STATUS"',
      'fi',
      `printf '%s' "$FAKE_SOPS_OUTPUT"`,
    ]);
    if (resolved.createSecretFile) {
      write(fixture, 'secrets/ci.yaml', 'encrypted\n');
    }
    const result = runProcess(
      'bash',
      fixture,
      [
        '-euo',
        'pipefail',
        '-c',
        yamlRunScript(SOPS_ACTION, 'Resolve and validate secret'),
      ],
      {
        ...baseEnvironment,
        CURL_MARKER: curlMarker,
        FAKE_CURL_STATUS: String(resolved.curlStatus),
        FAKE_SHA256_STATUS: String(resolved.sha256Status),
        FAKE_SOPS: fakeSops,
        FAKE_SOPS_OUTPUT: resolved.sopsOutput,
        FAKE_SOPS_STATUS: String(resolved.sopsStatus),
        FAKE_UNAME_MACHINE: resolved.unameMachine,
        GITHUB_ENV: environmentPath,
        GITHUB_OUTPUT: outputPath,
        PATH: `${bin}:${basePath}`,
        RUNNER_TEMP: runnerTemp,
        SOPS_AGE_KEY: resolved.ageKey,
        SOPS_ENV_NAME: resolved.envName,
        SOPS_FAILURE_MODE: resolved.failureMode,
        SOPS_FALLBACK_VALUE: resolved.fallbackValue,
        SOPS_MARKER: sopsMarker,
        SOPS_SECRET_FILE: 'secrets/ci.yaml',
        SOPS_SECRET_KEY: resolved.secretKey,
      },
    );
    return {
      curlCalled: existsSync(curlMarker),
      environment: existsSync(environmentPath)
        ? readFileSync(environmentPath, 'utf8')
        : '',
      output: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '',
      result,
      sopsBinaryPresent: existsSync(join(runnerTemp, 'sops')),
      sopsExecuted: existsSync(sopsMarker),
    };
  };
