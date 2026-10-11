// Input contract of the canonical app-release action: action.yml passes every
// input to release.sh, and release.sh rejects malformed inputs before it
// downloads SOPS, decrypts the key, requests a token, or contacts the host.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { parse as parseYaml } from 'yaml';
import {
  APP_RELEASE_ACTION,
  APP_RELEASE_SCRIPT,
  type AppReleaseOptions,
  type AppReleaseRun,
  createAppReleaseRunner,
  DIGEST_A,
  DIGEST_B,
  HOST,
  KNOWN_HOST,
} from './app-release-action-test-support';

const runAction = createAppReleaseRunner(process.env);

const INPUT_TITLE = '::error title=Invalid app-release input::';
const KEY = KNOWN_HOST.slice(HOST.length + 1);
const SCRIPT_VARIABLE = /\$\{(?<name>APP_RELEASE_[A-Z_]+)-\}/gu;

const expression = (path: string): string => ['$', `{{ ${path} }}`].join('');

// What a run must leave untouched when it rejects its inputs.
const workDone = (run: AppReleaseRun) => ({
  calls: ['curl', 'sops', 'ssh', 'docker'].flatMap((tool) => run.calls(tool)),
  output: run.output,
  summary: run.summary,
});
const NO_WORK = { calls: [], output: '', summary: '' };

type ActionStep = {
  readonly env?: Readonly<Record<string, string>>;
  readonly id?: string;
  readonly if?: string;
  readonly run?: string;
  readonly uses?: string;
};

type ActionMetadata = {
  readonly inputs: Readonly<
    Record<string, { readonly default?: string; readonly required?: boolean }>
  >;
  readonly outputs: Readonly<Record<string, { readonly value?: string }>>;
  readonly runs: {
    readonly using: string;
    readonly steps: ReadonlyArray<ActionStep>;
  };
};

describe('action.yml', () => {
  const action = parseYaml(
    readFileSync(APP_RELEASE_ACTION, 'utf8'),
  ) as ActionMetadata;
  const { steps } = action.runs;
  const releaseStep = steps.find((step) => step.id === 'release');

  it('declares the contract inputs and defaults', () => {
    expect(
      Object.fromEntries(
        Object.entries(action.inputs).map(([name, input]) => [
          name,
          input.required === true ? 'required' : input.default,
        ]),
      ),
    ).toEqual({
      command: 'release',
      images: '',
      unit: 'required',
      host: 'required',
      'known-host': 'required',
      'age-key': 'required',
      'ssh-key-path': 'ci.app_release.ssh_private_key',
      audience: 'app-release',
      'tag-production': 'true',
      'registry-token': expression('github.token'),
    });
  });

  it('exposes the release step outputs', () => {
    expect(
      Object.fromEntries(
        Object.entries(action.outputs).map(([name, output]) => [
          name,
          output.value,
        ]),
      ),
    ).toEqual({
      result: expression('steps.release.outputs.result'),
      'apps-json': expression('steps.release.outputs.apps-json'),
      'live-images': expression('steps.release.outputs.live-images'),
    });
  });

  it('passes every input to release.sh and reads nothing else from the caller', () => {
    const inputVariables = Object.keys(action.inputs).map((name) => [
      `APP_RELEASE_${name.toUpperCase().replaceAll('-', '_')}`,
      expression(`inputs.${name}`),
    ]);
    const script = readFileSync(APP_RELEASE_SCRIPT, 'utf8');
    const scriptVariables = new Set(
      [...script.matchAll(SCRIPT_VARIABLE)].map(
        (match) => match.groups?.name ?? '',
      ),
    );

    expect(action.runs.using).toBe('composite');
    expect(releaseStep?.run).toBe('bash "$GITHUB_ACTION_PATH/release.sh"');
    expect(releaseStep?.env).toEqual(
      Object.fromEntries([
        ...inputVariables,
        ['APP_RELEASE_WORK_DIR', expression('steps.work.outputs.path')],
      ]),
    );
    const byName = (left: string, right: string) => left.localeCompare(right);
    expect([...scriptVariables].sort(byName)).toEqual(
      Object.keys(releaseStep?.env ?? {}).sort(byName),
    );
  });

  // A relative `uses:` inside a composite action resolves against the
  // caller's workspace, so a step that called another local action would run
  // whatever the consumer keeps at that path.
  it('runs no other action and always removes its work directory', () => {
    const cleanup = steps.at(-1);

    expect(steps.filter((step) => step.uses !== undefined)).toEqual([]);
    expect(cleanup?.if).toBe('always()');
    expect(cleanup?.env).toEqual(
      Object.fromEntries([
        ['APP_RELEASE_WORK_DIR', expression('steps.work.outputs.path')],
      ]),
    );
    expect(cleanup?.run).toContain(
      '"$RUNNER_TEMP"/app-release.*) rm -rf -- "$APP_RELEASE_WORK_DIR" ;;',
    );
  });
});

// Each case breaks exactly one input, so it must produce exactly one problem.
const INVALID_INPUTS: ReadonlyArray<
  readonly [string, AppReleaseOptions['inputs'], string]
> = [
  ['unit', { unit: '-shop' }, 'unit must match'],
  ['unit', { unit: 'shop_1' }, 'unit must match'],
  ['unit', { unit: '' }, 'unit must match'],
  ['host', { host: 'Prod-1.example.com' }, 'host must be a lowercase DNS name'],
  ['host', { host: '192.0.2.1' }, 'host must be a lowercase DNS name'],
  ['host', { host: `${HOST}.` }, 'host must be a lowercase DNS name'],
  ['host', { host: 'prod..example.com' }, 'host must be a lowercase DNS name'],
  ['host', { host: `root@${HOST}` }, 'host must be a lowercase DNS name'],
  ['host', { host: `-${HOST}` }, 'host must be a lowercase DNS name'],
  [
    'known-host',
    { knownHost: `other.example.com ${KEY}` },
    'known-host must be one known_hosts line',
  ],
  // An unescaped dot in the host pattern would accept this look-alike.
  [
    'known-host',
    { knownHost: `prod-1xexample.com ${KEY}` },
    'known-host must be one known_hosts line',
  ],
  [
    'known-host',
    { knownHost: `@cert-authority ${KNOWN_HOST}` },
    'known-host must be one known_hosts line',
  ],
  [
    'known-host',
    { knownHost: `${KNOWN_HOST} comment` },
    'known-host must be one known_hosts line',
  ],
  [
    'known-host',
    { knownHost: `${KNOWN_HOST}\n${KNOWN_HOST}` },
    'known-host must be one known_hosts line',
  ],
  [
    'known-host',
    { knownHost: `${HOST},other.example.com ${KEY}` },
    'known-host must be one known_hosts line',
  ],
  [
    'known-host',
    { knownHost: `[${HOST}]:2222 ${KEY}` },
    'known-host must be one known_hosts line',
  ],
  [
    'known-host',
    { knownHost: `|1|c2FsdA==|aGFzaA== ${KEY}` },
    'known-host must be one known_hosts line',
  ],
  [
    'known-host',
    { knownHost: `${HOST} ssh-dss AAAAB3NzaC1kc3M=` },
    'known-host must be one known_hosts line',
  ],
  ['ssh-key-path', { sshKeyPath: '' }, 'ssh-key-path must be a dotted path'],
  ['ssh-key-path', { sshKeyPath: '.ci' }, 'ssh-key-path must be a dotted path'],
  ['ssh-key-path', { sshKeyPath: 'ci.' }, 'ssh-key-path must be a dotted path'],
  [
    'ssh-key-path',
    { sshKeyPath: 'CI.app_release.key' },
    'ssh-key-path must be a dotted path',
  ],
  [
    'ssh-key-path',
    { sshKeyPath: 'ci.app-release.key' },
    'ssh-key-path must be a dotted path',
  ],
  [
    'ssh-key-path',
    { sshKeyPath: 'ci["app_release"]' },
    'ssh-key-path must be a dotted path',
  ],
  ['images', { images: '' }, 'images must list at least one'],
  ['images', { images: '\n  \n' }, 'images must list at least one'],
  ['images', { images: 'web:latest' }, "images line 'web:latest' must be"],
  [
    'images',
    { images: `Web@${DIGEST_A}` },
    `images line 'Web@${DIGEST_A}' must be`,
  ],
  [
    'images',
    { images: `web@${DIGEST_A.toUpperCase()}` },
    'must be <app>@sha256:<64 lowercase hex>',
  ],
  [
    'images',
    { images: `web@${DIGEST_A.slice(0, -1)}` },
    'must be <app>@sha256:<64 lowercase hex>',
  ],
  [
    'images',
    { images: `web@${DIGEST_A} worker@${DIGEST_B}` },
    'must be <app>@sha256:<64 lowercase hex>',
  ],
  [
    'images',
    { images: `web@${DIGEST_A}\nweb@${DIGEST_B}` },
    'images names app web more than once',
  ],
  [
    'images',
    { command: 'rollback', images: `web@${DIGEST_A}` },
    'images is only accepted by the release command',
  ],
  [
    'images',
    { command: 'status', images: `web@${DIGEST_A}` },
    'images is only accepted by the release command',
  ],
  ['audience', { audience: 'app release' }, 'audience must match'],
  [
    'registry-token',
    { registryToken: '' },
    'registry-token must be a non-empty token without whitespace',
  ],
  [
    'registry-token',
    { command: 'rollback', images: '', registryToken: 'two words' },
    'registry-token must be a non-empty token without whitespace',
  ],
];

describe('input validation', () => {
  it('reports every problem at once before any work', () => {
    const run = runAction({
      inputs: {
        command: 'deploy',
        images: '',
        unit: 'Shop',
        host: 'localhost',
        sshKeyPath: 'ci..key',
        audience: '',
        tagProduction: 'yes',
        ageKey: '',
      },
      withoutOidc: true,
      createSecretFile: false,
    });

    expect(run.result.status).toBe(1);
    expect(workDone(run)).toEqual(NO_WORK);
    expect(run.result.stdout.split('\n')).toEqual([
      `${INPUT_TITLE}command must be release, rollback, or status`,
      `${INPUT_TITLE}unit must match ^[a-z0-9][a-z0-9-]*$`,
      `${INPUT_TITLE}host must be a lowercase DNS name such as prod-1.example.com`,
      `${INPUT_TITLE}ssh-key-path must be a dotted path into secrets/ci.yaml matching ^[a-z0-9_]+(\\.[a-z0-9_]+)*$`,
      `${INPUT_TITLE}audience must match ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`,
      `${INPUT_TITLE}tag-production must be true or false`,
      `${INPUT_TITLE}age-key is empty; pass the SOPS_AGE_KEY secret that decrypts secrets/ci.yaml`,
      `${INPUT_TITLE}GitHub OIDC is unavailable; grant the job permissions: id-token: write`,
      `${INPUT_TITLE}secrets/ci.yaml does not exist; check out the repository before this action`,
      '',
    ]);
  });

  it.each(INVALID_INPUTS)(
    'rejects an invalid %s %j',
    (_input, inputs, message) => {
      const run = runAction({ inputs });

      expect(run.result.status).toBe(1);
      expect(workDone(run)).toEqual(NO_WORK);
      const problems = run.result.stdout.trimEnd().split('\n');
      expect(problems).toHaveLength(1);
      expect(problems[0]).toStartWith(INPUT_TITLE);
      expect(problems[0]).toContain(message);
    },
  );

  it('accepts a status request without a registry token or images', () => {
    const run = runAction({
      inputs: { command: 'status', images: '\n', registryToken: '' },
      sshOutput:
        'APP_RELEASE_RESULT {"unit":"shop","result":"status","message":"","apps":{}}\n',
    });

    expect(run.result.status).toBe(0);
    expect(run.log).not.toContain(INPUT_TITLE);
  });
});
