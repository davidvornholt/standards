// Successful paths of the canonical app-release action: the exact SSH call and
// its stdin, the parsed result and step outputs, the job summary, and the
// production tags that follow a release, an unchanged result, or a rollback.

import { describe, expect, it } from 'bun:test';
import process from 'node:process';
import {
  AGE_KEY,
  type AppReleaseRun,
  createAppReleaseRunner,
  DIGEST_A,
  DIGEST_B,
  DIGEST_C,
  HOST,
  KNOWN_HOST,
  liveApp,
  OIDC_TOKEN,
  REGISTRY_TOKEN,
  REQUEST_TOKEN,
  resultLine,
  SSH_PRIVATE_KEY,
  sharedRun,
} from './app-release-action-test-support';

const runAction = createAppReleaseRunner(process.env);
const SECRET_FILE_PATH = /\/workspace\/secrets\/ci\.yaml$/u;

const hostOutput = (result: Record<string, unknown>): string =>
  `Pulling images\nSwitching traffic\n${resultLine({ unit: 'shop', message: '', ...result })}`;

const expectedSshArgs = (run: AppReleaseRun, remoteCommand: string) => [
  '-F',
  'none',
  '-T',
  '-o',
  'BatchMode=yes',
  '-o',
  'IdentitiesOnly=yes',
  '-o',
  'IdentityAgent=none',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  `UserKnownHostsFile=${run.workDir}/known_hosts`,
  '-o',
  'GlobalKnownHostsFile=/dev/null',
  '-o',
  'CheckHostIP=no',
  '-o',
  'UpdateHostKeys=no',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=8',
  '-o',
  'ConnectTimeout=15',
  '-i',
  `${run.workDir}/id`,
  `root@${HOST}`,
  remoteCommand,
];

const imagetoolsArgs = (repository: string, digest: string) => [
  'buildx',
  'imagetools',
  'create',
  '--prefer-index=false',
  '--tag',
  `${repository}:production`,
  `${repository}@${digest}`,
];

const released = sharedRun(() =>
  runAction({
    sshOutput: hostOutput({
      result: 'released',
      apps: { web: liveApp(DIGEST_A, DIGEST_B) },
      message: 'Released 1 app',
    }),
  }),
);

describe('a release', () => {
  it('calls the host over strict SSH with the token on stdin', () => {
    const run = released();

    expect(run.result.status).toBe(0);
    const [ssh] = run.calls('ssh');
    expect(ssh?.args).toEqual(expectedSshArgs(run, `release web@${DIGEST_A}`));
    expect(ssh?.stdin).toBe(`${OIDC_TOKEN}\n`);
    expect(ssh?.files.key).toBe(SSH_PRIVATE_KEY);
    expect(ssh?.files['key-mode']).toBe('600\n');
    expect(ssh?.files['known-hosts']).toBe(`${KNOWN_HOST}\n`);
    expect(run.log).toContain('Pulling images\nSwitching traffic\n');
    expect(run.workDirRemains).toBe(false);
  });

  it('writes the step outputs and the job summary', () => {
    const run = released();

    expect(run.output).toBe(
      [
        'result=released',
        `apps-json=${JSON.stringify({ web: liveApp(DIGEST_A, DIGEST_B) })}`,
        'live-images<<APP_RELEASE_LIVE_IMAGES_EOF',
        `ghcr.io/example/web@${DIGEST_A}`,
        'APP_RELEASE_LIVE_IMAGES_EOF',
        '',
      ].join('\n'),
    );
    expect(run.summary).toContain('Result: **released**\n\nReleased 1 app\n');
    expect(run.summary).toContain(
      `| \`web\` | \`${DIGEST_A}\` | \`${DIGEST_B}\` | green |`,
    );
    expect(run.summary).toContain(
      `- Moved \`ghcr.io/example/web:production\` to \`${DIGEST_A}\``,
    );
  });

  it('moves the production tag after a login in a private Docker config', () => {
    const run = released();

    const docker = run.calls('docker');
    expect(docker.map((call) => call.args)).toEqual([
      ['login', 'ghcr.io', '--username', 'release-bot', '--password-stdin'],
      imagetoolsArgs('ghcr.io/example/web', DIGEST_A),
    ]);
    expect(docker[0]?.stdin).toBe(`${REGISTRY_TOKEN}\n`);
    for (const call of docker) {
      expect(call.files['docker-config']).toBe(`${run.workDir}/docker`);
    }
  });

  it('never prints the OIDC token, age key, registry token, or SSH key', () => {
    const run = released();

    const tokenLines = run.log
      .split('\n')
      .filter((line) => line.includes(OIDC_TOKEN));
    expect(tokenLines).toEqual([`::add-mask::${OIDC_TOKEN}`]);
    const keyLines = SSH_PRIVATE_KEY.split('\n').filter(Boolean);
    for (const line of keyLines) {
      expect(run.log).toContain(`::add-mask::${line}\n`);
    }
    const unmasked = run.log
      .split('\n')
      .filter((line) => !line.startsWith('::add-mask::'))
      .join('\n');
    for (const secret of [
      OIDC_TOKEN,
      AGE_KEY,
      REGISTRY_TOKEN,
      REQUEST_TOKEN,
      ...keyLines,
    ]) {
      expect(unmasked).not.toContain(secret);
      expect(run.output).not.toContain(secret);
      expect(run.summary).not.toContain(secret);
    }
  });

  it('hands each credential only to the process that needs it', () => {
    const run = released();

    const [sopsDownload, oidcRequest] = run.calls('curl');
    expect(sopsDownload?.args.at(-1)).toStartWith(
      'https://github.com/getsops/sops/releases/download/',
    );
    expect(oidcRequest?.args).toEqual([
      '-fsS',
      '-H',
      '@-',
      'https://oidc.example.test/token?api-version=2.0&audience=app-release',
    ]);
    expect(oidcRequest?.stdin).toBe(`Authorization: bearer ${REQUEST_TOKEN}\n`);
    const [sops] = run.calls('sops');
    expect(sops?.args).toEqual([
      'decrypt',
      '--extract',
      '["ci"]["app_release"]["ssh_private_key"]',
      expect.stringMatching(SECRET_FILE_PATH),
    ]);
    expect(sops?.files['age-key']).toBe(AGE_KEY);
    for (const call of [...run.calls('ssh'), ...run.calls('docker')]) {
      expect(call.files.env).not.toContain(AGE_KEY);
      expect(call.files.env).not.toContain(REGISTRY_TOKEN);
      expect(call.files.env).not.toContain(OIDC_TOKEN);
    }
  });
});

const multiApp = sharedRun(() =>
  runAction({
    inputs: {
      images: `\n  web@${DIGEST_A}  \r\n\nworker@${DIGEST_B}\n\n`,
      sshKeyPath: 'ci.app_release.translationbench_ssh_private_key',
    },
    sopsOutput: SSH_PRIVATE_KEY.trimEnd(),
    sshOutput: hostOutput({
      result: 'released',
      apps: {
        worker: liveApp(DIGEST_B, null, null, 'ghcr.io/example/worker'),
        web: liveApp(DIGEST_A, DIGEST_C, 'blue'),
      },
    }),
  }),
);

describe('a multi-app unit with its own key path', () => {
  it('sends every app and tags each live repository', () => {
    const run = multiApp();

    expect(run.result.status).toBe(0);
    expect(run.calls('ssh')[0]?.args.at(-1)).toBe(
      `release web@${DIGEST_A} worker@${DIGEST_B}`,
    );
    expect(run.output).toContain(
      [
        'live-images<<APP_RELEASE_LIVE_IMAGES_EOF',
        `ghcr.io/example/web@${DIGEST_A}`,
        `ghcr.io/example/worker@${DIGEST_B}`,
        'APP_RELEASE_LIVE_IMAGES_EOF',
      ].join('\n'),
    );
    expect(run.summary).toContain(
      `| \`worker\` | \`${DIGEST_B}\` | none | none |`,
    );
    expect(run.calls('docker').map((call) => call.args)).toEqual([
      ['login', 'ghcr.io', '--username', 'release-bot', '--password-stdin'],
      imagetoolsArgs('ghcr.io/example/web', DIGEST_A),
      imagetoolsArgs('ghcr.io/example/worker', DIGEST_B),
    ]);
  });

  it('decrypts the key at ssh-key-path and adds the final newline OpenSSH requires', () => {
    const run = multiApp();

    expect(run.calls('sops')[0]?.args.slice(0, 3)).toEqual([
      'decrypt',
      '--extract',
      '["ci"]["app_release"]["translationbench_ssh_private_key"]',
    ]);
    expect(run.calls('ssh')[0]?.files.key).toBe(SSH_PRIVATE_KEY);
  });
});

describe('other release results', () => {
  it('moves the production tag for an unchanged result', () => {
    const run = runAction({
      sshOutput: hostOutput({
        result: 'unchanged',
        apps: { web: liveApp(DIGEST_A, DIGEST_B) },
      }),
    });

    expect(run.result.status).toBe(0);
    expect(run.output).toStartWith('result=unchanged\n');
    expect(run.calls('docker').at(-1)?.args).toEqual(
      imagetoolsArgs('ghcr.io/example/web', DIGEST_A),
    );
  });

  it('reports a superseded release without touching the production tag', () => {
    const run = runAction({
      sshOutput: hostOutput({
        result: 'superseded',
        apps: { web: liveApp(DIGEST_C, DIGEST_B) },
        message: 'A newer run already released',
      }),
    });

    expect(run.result.status).toBe(0);
    expect(run.output).toContain('result=superseded\n');
    expect(run.output).toContain(`ghcr.io/example/web@${DIGEST_C}\n`);
    expect(run.summary).toContain('Result: **superseded**');
    expect(run.calls('docker')).toEqual([]);
    expect(run.log).not.toContain('::error');
  });

  it('skips the production tag when tag-production is false', () => {
    const run = runAction({
      inputs: { tagProduction: 'false', registryToken: '' },
      sshOutput: hostOutput({
        result: 'released',
        apps: { web: liveApp(DIGEST_A, DIGEST_B) },
      }),
    });

    expect(run.result.status).toBe(0);
    expect(run.calls('docker')).toEqual([]);
  });
});

describe('rollback and status', () => {
  it('rolls back and points production at the restored digest', () => {
    const run = runAction({
      inputs: { command: 'rollback', images: '' },
      sshOutput: hostOutput({
        result: 'rolled-back',
        apps: { web: liveApp(DIGEST_B, DIGEST_A, 'blue') },
      }),
    });

    expect(run.result.status).toBe(0);
    const [ssh] = run.calls('ssh');
    expect(ssh?.args).toEqual(expectedSshArgs(run, 'rollback'));
    expect(ssh?.stdin).toBe(`${OIDC_TOKEN}\n`);
    expect(run.calls('docker').at(-1)?.args).toEqual(
      imagetoolsArgs('ghcr.io/example/web', DIGEST_B),
    );
  });

  it('reports status without a registry token or any tagging', () => {
    const run = runAction({
      inputs: { command: 'status', images: '', registryToken: '' },
      sshOutput: hostOutput({
        result: 'status',
        apps: { web: liveApp(DIGEST_A, DIGEST_B) },
      }),
    });

    expect(run.result.status).toBe(0);
    expect(run.calls('ssh')[0]?.args.at(-1)).toBe('status');
    expect(run.output).toStartWith('result=status\n');
    expect(run.calls('docker')).toEqual([]);
  });
});
