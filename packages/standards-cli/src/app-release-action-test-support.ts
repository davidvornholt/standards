// PATH-shim harness for the canonical app-release action's release.sh. Stubs
// stand in for uname, curl, sha256sum, the downloaded sops binary, ssh, and
// docker, and record every call, so suites can drive each host outcome and
// assert what reached which process without network access or a real runner.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTUAL_UPSTREAM, type RunResult, write } from './cli-test-support';

export const APP_RELEASE_ACTION_DIR = join(
  ACTUAL_UPSTREAM,
  '.github/actions/app-release',
);
export const APP_RELEASE_ACTION = join(APP_RELEASE_ACTION_DIR, 'action.yml');
export const APP_RELEASE_SCRIPT = join(APP_RELEASE_ACTION_DIR, 'release.sh');

const EXECUTABLE_MODE = 0o755;
const DIGEST_HEX_LENGTH = 64;

export const OIDC_TOKEN =
  'eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3QifQ.eyJzdWIiOiJyZXBvOmV4YW1wbGUvYXBwIn0.c2lnbmF0dXJlLWJ5dGVz';
export const AGE_KEY = 'AGE-SECRET-KEY-1TESTAGEKEYVALUE';
export const REGISTRY_TOKEN = 'ghs_registryTokenValue';
export const REQUEST_TOKEN = 'request-token-value';
export const SSH_PRIVATE_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  'QyNTUxOQAAACBzZWNyZXQta2V5LW1hdGVyaWFsLWZvci10ZXN0cw==',
  '-----END OPENSSH PRIVATE KEY-----',
  '',
].join('\n');
export const HOST = 'prod-1.example.com';
export const KNOWN_HOST = `${HOST} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFkom7Y24gnBa9X+gUDBZvlCnXiuKTo87ROOtlMpgNH5`;
export const DIGEST_A = `sha256:${'a'.repeat(DIGEST_HEX_LENGTH)}`;
export const DIGEST_B = `sha256:${'b'.repeat(DIGEST_HEX_LENGTH)}`;
export const DIGEST_C = `sha256:${'c'.repeat(DIGEST_HEX_LENGTH)}`;

export type AppReleaseInputs = {
  readonly command: string;
  readonly images: string;
  readonly unit: string;
  readonly host: string;
  readonly knownHost: string;
  readonly ageKey: string;
  readonly sshKeyPath: string;
  readonly audience: string;
  readonly tagProduction: string;
  readonly registryToken: string;
};

export type AppReleaseOptions = {
  readonly inputs?: Partial<AppReleaseInputs>;
  readonly withoutOidc?: boolean;
  readonly createSecretFile?: boolean;
  readonly oidcResponse?: string;
  readonly oidcStatus?: number;
  readonly sopsOutput?: string;
  readonly sopsStatus?: number;
  readonly sshOutput?: string;
  readonly sshStatus?: number;
  readonly dockerFailOn?: 'login' | 'imagetools' | '';
};

export type StubCall = {
  readonly args: ReadonlyArray<string>;
  readonly stdin: string;
  readonly files: Readonly<Record<string, string>>;
};

export type AppReleaseRun = {
  readonly result: RunResult;
  readonly log: string;
  readonly output: string;
  readonly summary: string;
  readonly workDir: string;
  readonly workDirRemains: boolean;
  readonly calls: (tool: string) => ReadonlyArray<StubCall>;
};

const DEFAULT_INPUTS: AppReleaseInputs = {
  command: 'release',
  images: `web@${DIGEST_A}\n`,
  unit: 'shop',
  host: HOST,
  knownHost: KNOWN_HOST,
  ageKey: AGE_KEY,
  sshKeyPath: 'ci.app_release.ssh_private_key',
  audience: 'app-release',
  tagProduction: 'true',
  registryToken: REGISTRY_TOKEN,
};

// Every stub stores its argv (NUL-separated), stdin, and any extra captured
// files as <tool>.<call number>.<name> in the calls directory. The stubs use
// shell builtins only, so a scenario costs few processes on a loaded runner.
const recordCall = (tool: string): ReadonlyArray<string> => [
  'index=0',
  `while [ -e "$CALLS/${tool}.$index.args" ]; do index=$((index + 1)); done`,
  `call="$CALLS/${tool}.$index"`,
  'printf "%s\\0" "$@" >"$call.args"',
];
const RECORD_STDIN = [
  'stdin=""',
  'IFS= read -r -d "" stdin || true',
  'printf "%s" "$stdin" >"$call.stdin"',
];
// Prints a file without starting cat.
const PRINT_FILE =
  'print_file() { local content=""; IFS= read -r -d "" content <"$1" || true; printf "%s" "$content"; }';

const STUBS: Readonly<Record<string, ReadonlyArray<string>>> = {
  uname: ['printf "%s\\n" x86_64'],
  curl: [
    ...recordCall('curl'),
    PRINT_FILE,
    'for url; do :; done',
    'case "$url" in',
    '  https://github.com/getsops/sops/releases/download/*) print_file "$FAKE_SOPS" >"$2" ;;',
    '  "$ACTIONS_ID_TOKEN_REQUEST_URL"*)',
    ...RECORD_STDIN.map((line) => `    ${line}`),
    '    print_file "$FAKE_DATA/oidc-response"',
    '    exit "$FAKE_OIDC_STATUS" ;;',
    '  *) exit 7 ;;',
    'esac',
  ],
  sha256sum: [
    'read -r digest target',
    '[[ "$digest" =~ ^[a-f0-9]{64}$ ]] || exit 1',
    '[ "$target" = "$APP_RELEASE_WORK_DIR/sops" ] || exit 1',
    'IFS= read -r -d "" actual <"$target" || true',
    'IFS= read -r -d "" expected <"$FAKE_SOPS" || true',
    '[ "$actual" = "$expected" ] || exit 1',
  ],
  // The argv assertions pin -i and UserKnownHostsFile to these two files.
  ssh: [
    ...recordCall('ssh'),
    ...RECORD_STDIN,
    PRINT_FILE,
    'print_file "$APP_RELEASE_WORK_DIR/id" >"$call.key"',
    'stat -c %a "$APP_RELEASE_WORK_DIR/id" >"$call.key-mode"',
    'print_file "$APP_RELEASE_WORK_DIR/known_hosts" >"$call.known-hosts"',
    'export -p >"$call.env"',
    'print_file "$FAKE_DATA/ssh-output"',
    'echo "host stderr line" >&2',
    'exit "$FAKE_SSH_STATUS"',
  ],
  docker: [
    ...recordCall('docker'),
    'if [ "$1" = login ]; then',
    ...RECORD_STDIN.map((line) => `  ${line}`),
    'fi',
    'export -p >"$call.env"',
    'printf "%s" "$DOCKER_CONFIG" >"$call.docker-config"',
    'if [ "$1" = login ] && [ "$FAKE_DOCKER_FAIL_ON" = login ]; then exit 1; fi',
    'if [ "$1" = buildx ] && [ "$FAKE_DOCKER_FAIL_ON" = imagetools ]; then exit 1; fi',
  ],
};

const FAKE_SOPS = [
  ...recordCall('sops'),
  PRINT_FILE,
  'printf "%s" "$SOPS_AGE_KEY" >"$call.age-key"',
  'if [ "$FAKE_SOPS_STATUS" -ne 0 ]; then exit "$FAKE_SOPS_STATUS"; fi',
  'print_file "$FAKE_DATA/sops-output"',
];

const shim = (path: string, body: ReadonlyArray<string>, root: string) => {
  write(
    root,
    path,
    ['#!/usr/bin/env bash', 'set -euo pipefail', ...body, ''].join('\n'),
  );
  chmodSync(join(root, path), EXECUTABLE_MODE);
};

const CALL_FILE = /^(?<tool>[a-z0-9]+)\.(?<index>\d+)\.(?<name>[a-z-]+)$/u;

// Reads every recorded call up front, so a run stays inspectable after its
// fixture directory is gone.
const readCalls = (
  callsDir: string,
): ReadonlyMap<string, ReadonlyArray<StubCall>> => {
  const files = new Map<string, Record<string, string>>();
  for (const entry of readdirSync(callsDir)) {
    const groups = CALL_FILE.exec(entry)?.groups;
    if (groups?.tool === undefined || groups.name === undefined) {
      throw new Error(`unexpected stub call file ${entry}`);
    }
    const key = `${groups.tool}.${groups.index}`;
    const callFiles = files.get(key) ?? {};
    callFiles[groups.name] = readFileSync(join(callsDir, entry), 'utf8');
    files.set(key, callFiles);
  }
  const calls = new Map<string, Array<StubCall>>();
  const keys = [...files.keys()].sort((left, right) =>
    left.localeCompare(right, 'en', { numeric: true }),
  );
  for (const key of keys) {
    const callFiles = files.get(key) ?? {};
    const { args = '', stdin = '' } = callFiles;
    const tool = key.slice(0, key.indexOf('.'));
    calls.set(tool, [
      ...(calls.get(tool) ?? []),
      { args: args.split('\0').slice(0, -1), stdin, files: callFiles },
    ]);
  }
  return calls;
};

export const resultLine = (result: Record<string, unknown>): string =>
  `APP_RELEASE_RESULT ${JSON.stringify(result)}\n`;

export const liveApp = (
  digest: string,
  previousDigest: string | null,
  slot: string | null = 'green',
  repository = 'ghcr.io/example/web',
) => ({ repository, digest, previousDigest, slot });

type Fixture = {
  readonly callsDir: string;
  readonly outputPath: string;
  readonly root: string;
  readonly runnerTemp: string;
  readonly summaryPath: string;
  readonly workDir: string;
  readonly workspace: string;
};

// Fake host, OIDC, and SOPS responses live in files rather than variables, so
// the environment each stub records holds only what release.sh passed on.
const createFixture = (options: AppReleaseOptions): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'app-release-action-'));
  const runnerTemp = join(root, 'runner');
  const fixture = {
    callsDir: join(root, 'calls'),
    outputPath: join(root, 'github-output'),
    root,
    runnerTemp,
    summaryPath: join(root, 'github-step-summary'),
    workDir: join(runnerTemp, 'app-release.test'),
    workspace: join(root, 'workspace'),
  };
  for (const directory of [
    fixture.workspace,
    fixture.workDir,
    fixture.callsDir,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  for (const [name, body] of Object.entries(STUBS)) {
    shim(`bin/${name}`, body, root);
  }
  shim('fake-sops/sops', FAKE_SOPS, root);
  if (options.createSecretFile ?? true) {
    write(fixture.workspace, 'secrets/ci.yaml', 'encrypted\n');
  }
  write(
    root,
    'fake-data/oidc-response',
    options.oidcResponse ?? JSON.stringify({ count: 1, value: OIDC_TOKEN }),
  );
  write(root, 'fake-data/sops-output', options.sopsOutput ?? SSH_PRIVATE_KEY);
  write(root, 'fake-data/ssh-output', options.sshOutput ?? '');
  return fixture;
};

const OIDC_REQUEST_VARIABLE = /^ACTIONS_ID_TOKEN_REQUEST_/u;

const childEnvironment = (
  baseEnvironment: Readonly<Record<string, string | undefined>>,
  basePath: string,
  fixture: Fixture,
  options: AppReleaseOptions,
): Record<string, string> => {
  const inputs = { ...DEFAULT_INPUTS, ...options.inputs };
  const environment: Record<string, string | undefined> = {
    ...baseEnvironment,
    PATH: `${join(fixture.root, 'bin')}:${basePath}`,
    CALLS: fixture.callsDir,
    FAKE_DATA: join(fixture.root, 'fake-data'),
    FAKE_SOPS: join(fixture.root, 'fake-sops/sops'),
    FAKE_SOPS_STATUS: String(options.sopsStatus ?? 0),
    FAKE_OIDC_STATUS: String(options.oidcStatus ?? 0),
    FAKE_SSH_STATUS: String(options.sshStatus ?? 0),
    FAKE_DOCKER_FAIL_ON: options.dockerFailOn ?? '',
    ACTIONS_ID_TOKEN_REQUEST_URL:
      'https://oidc.example.test/token?api-version=2.0',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
    APP_RELEASE_COMMAND: inputs.command,
    APP_RELEASE_IMAGES: inputs.images,
    APP_RELEASE_UNIT: inputs.unit,
    APP_RELEASE_HOST: inputs.host,
    APP_RELEASE_KNOWN_HOST: inputs.knownHost,
    APP_RELEASE_AGE_KEY: inputs.ageKey,
    APP_RELEASE_SSH_KEY_PATH: inputs.sshKeyPath,
    APP_RELEASE_AUDIENCE: inputs.audience,
    APP_RELEASE_TAG_PRODUCTION: inputs.tagProduction,
    APP_RELEASE_REGISTRY_TOKEN: inputs.registryToken,
    APP_RELEASE_WORK_DIR: fixture.workDir,
    GITHUB_ACTOR: 'release-bot',
    GITHUB_OUTPUT: fixture.outputPath,
    GITHUB_STEP_SUMMARY: fixture.summaryPath,
    GITHUB_WORKSPACE: fixture.workspace,
    RUNNER_TEMP: fixture.runnerTemp,
  };
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !(options.withoutOidc === true && OIDC_REQUEST_VARIABLE.test(entry[0])),
    ),
  );
};

const readIfPresent = (path: string): string =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

export const createAppReleaseRunner =
  (baseEnvironment: Readonly<Record<string, string | undefined>>) =>
  (options: AppReleaseOptions = {}): AppReleaseRun => {
    const basePath = baseEnvironment.PATH;
    if (basePath === undefined) {
      throw new Error('base environment must define PATH for the shim prefix');
    }
    const fixture = createFixture(options);
    try {
      const child = spawnSync('bash', [APP_RELEASE_SCRIPT], {
        cwd: fixture.workspace,
        encoding: 'utf8',
        env: childEnvironment(baseEnvironment, basePath, fixture, options),
      });
      const result: RunResult = {
        stdout: child.stdout,
        stderr: child.stderr,
        status: child.status ?? 1,
      };
      const calls = readCalls(fixture.callsDir);
      return {
        result,
        log: `${result.stdout}${result.stderr}`,
        output: readIfPresent(fixture.outputPath),
        summary: readIfPresent(fixture.summaryPath),
        workDir: fixture.workDir,
        workDirRemains: existsSync(fixture.workDir),
        calls: (tool) => calls.get(tool) ?? [],
      };
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  };

// Runs a scenario on first use and shares the result, so several tests can
// assert on one run of the script.
export const sharedRun = (
  scenario: () => AppReleaseRun,
): (() => AppReleaseRun) => {
  let run: AppReleaseRun | undefined;
  return () => {
    run ??= scenario();
    return run;
  };
};
