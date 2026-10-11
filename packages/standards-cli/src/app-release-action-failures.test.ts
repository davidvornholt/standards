// Failure paths of the canonical app-release action: each host exit code maps
// to its own annotation, an absent or inconsistent result fails the step, and
// production tags move only after a confirmed successful result.

import { describe, expect, it } from 'bun:test';
import process from 'node:process';
import {
  createAppReleaseRunner,
  DIGEST_A,
  DIGEST_B,
  HOST,
  liveApp,
  resultLine,
} from './app-release-action-test-support';

const runAction = createAppReleaseRunner(process.env);

const failedResult = resultLine({
  unit: 'shop',
  result: 'failed',
  apps: { web: liveApp(DIGEST_B, null) },
  message: 'health check timed out',
});
const releasedResult = resultLine({
  unit: 'shop',
  result: 'released',
  apps: { web: liveApp(DIGEST_A, DIGEST_B) },
  message: '',
});

type ExitScenario = {
  readonly status: number;
  readonly title: string;
  readonly text: string;
};

const EXIT_SCENARIOS: ReadonlyArray<readonly [string, ExitScenario]> = [
  [
    '1: failed with the previous version serving',
    {
      status: 1,
      title: 'App release failed',
      text: 'The release for unit shop failed, and the previous version is still serving. Host message: health check timed out',
    },
  ],
  [
    '2: rejected',
    {
      status: 2,
      title: 'App release rejected',
      text: 'The host rejected the release request for unit shop (authorization, validation, or syntax).',
    },
  ],
  [
    '3: failed without restoring the previous version',
    {
      status: 3,
      title: 'App release critical failure',
      text: 'Production may be down. The release for unit shop failed, and the previous version could not be restored.',
    },
  ],
  [
    '4: lock wait timed out',
    {
      status: 4,
      title: 'App release lock timeout',
      text: 'Another app-release operation held the lock for unit shop longer than the wait timeout.',
    },
  ],
];

describe('host exit codes', () => {
  it.each(EXIT_SCENARIOS)(
    'explains exit code %s and never tags',
    (_label, scenario) => {
      const run = runAction({
        sshStatus: scenario.status,
        sshOutput: `Pulling images\n${failedResult}`,
      });

      expect(run.result.status).toBe(scenario.status);
      expect(run.log).toContain(`::error title=${scenario.title}::`);
      expect(run.log).toContain(scenario.text);
      expect(run.output).toStartWith('result=failed\n');
      expect(run.output).toContain(`ghcr.io/example/web@${DIGEST_B}\n`);
      expect(run.summary).toContain(
        `exited with code ${scenario.status}.\n\nResult: **failed**`,
      );
      expect(run.calls('docker')).toEqual([]);
      expect(run.workDirRemains).toBe(false);
    },
  );

  it('fails on a connection error without a result line', () => {
    const run = runAction({ sshStatus: 255 });

    expect(run.result.status).toBe(255);
    expect(run.log).toContain(
      `::error title=App release connection failed::SSH to root@${HOST} failed`,
    );
    expect(run.output).toBe('');
    expect(run.summary).toContain(
      'The host returned no valid `APP_RELEASE_RESULT` line.',
    );
  });

  it('escapes a multi-line host message into one annotation', () => {
    const run = runAction({
      sshStatus: 1,
      sshOutput: resultLine({
        unit: 'shop',
        result: 'failed',
        apps: {},
        message: 'first\n::error::injected 100%',
      }),
    });

    expect(run.log).toContain(
      'Host message: first%0A::error::injected 100%25\n',
    );
    expect(run.log).not.toContain('\n::error::injected');
  });
});

describe('result validation', () => {
  it('fails a zero exit without a result line', () => {
    const run = runAction({ sshOutput: 'Released\n' });

    expect(run.result.status).toBe(1);
    expect(run.log).toContain(
      '::error title=App release::The host exited 0 without a valid APP_RELEASE_RESULT line',
    );
    expect(run.output).toBe('');
    expect(run.calls('docker')).toEqual([]);
  });

  it.each([
    ['another unit', { unit: 'other' }],
    ['an unknown result', { result: 'deployed' }],
    ['a malformed digest', { apps: { web: liveApp('sha256:abc', null) } }],
    [
      'a repository with a shell metacharacter',
      { apps: { web: liveApp(DIGEST_A, null, 'blue', 'ghcr.io/x;rm') } },
    ],
    ['an unknown slot', { apps: { web: liveApp(DIGEST_A, null, 'red') } }],
    ['a missing message', { message: undefined }],
  ] as ReadonlyArray<readonly [string, Record<string, unknown>]>)(
    'rejects a result line naming %s',
    (_label, override) => {
      const run = runAction({
        sshOutput: resultLine({
          unit: 'shop',
          result: 'released',
          apps: { web: liveApp(DIGEST_A, DIGEST_B) },
          message: '',
          ...override,
        }),
      });

      expect(run.result.status).toBe(1);
      expect(run.log).toContain('without a valid APP_RELEASE_RESULT line');
      expect(run.output).toBe('');
      expect(run.calls('docker')).toEqual([]);
    },
  );

  it('uses the last result line', () => {
    const run = runAction({
      sshOutput: `${failedResult}retrying\n${releasedResult}`,
    });

    expect(run.result.status).toBe(0);
    expect(run.output).toStartWith('result=released\n');
  });

  it('fails a zero exit whose result does not fit the command', () => {
    const run = runAction({ sshOutput: failedResult });

    expect(run.result.status).toBe(1);
    expect(run.log).toContain(
      'The host reported result failed for the release command.',
    );
    expect(run.calls('docker')).toEqual([]);
  });

  it('refuses to tag when the live digests differ from the requested images', () => {
    const run = runAction({
      sshOutput: resultLine({
        unit: 'shop',
        result: 'released',
        apps: { web: liveApp(DIGEST_B, DIGEST_A) },
        message: '',
      }),
    });

    expect(run.result.status).toBe(1);
    expect(run.log).toContain(
      'its live apps and digests differ from the requested images',
    );
    expect(run.calls('docker')).toEqual([]);
  });
});

describe('production tagging failures', () => {
  it('fails when the registry login fails', () => {
    const run = runAction({ sshOutput: releasedResult, dockerFailOn: 'login' });

    expect(run.result.status).toBe(1);
    expect(run.log).toContain(
      'The release succeeded, but logging in to ghcr.io to move the production tags failed; the job needs packages: write. Re-run this job to retry.',
    );
    expect(run.calls('docker')).toHaveLength(1);
  });

  it('fails when moving a production tag fails', () => {
    const run = runAction({
      sshOutput: releasedResult,
      dockerFailOn: 'imagetools',
    });

    expect(run.result.status).toBe(1);
    expect(run.log).toContain(
      `The release succeeded, but pointing ghcr.io/example/web:production at ${DIGEST_A} failed. Re-run this job to retry.`,
    );
  });

  it('warns against re-running a rollback whose tagging failed', () => {
    const run = runAction({
      inputs: { command: 'rollback', images: '' },
      sshOutput: resultLine({
        unit: 'shop',
        result: 'rolled-back',
        apps: { web: liveApp(DIGEST_B, DIGEST_A) },
        message: '',
      }),
      dockerFailOn: 'imagetools',
    });

    expect(run.result.status).toBe(1);
    expect(run.log).toContain(
      'Do not re-run the rollback, which would switch back;',
    );
  });

  it('refuses to tag a repository outside ghcr.io', () => {
    const run = runAction({
      sshOutput: resultLine({
        unit: 'shop',
        result: 'released',
        apps: {
          web: liveApp(DIGEST_A, null, 'blue', 'registry.example.com/web'),
        },
        message: '',
      }),
    });

    expect(run.result.status).toBe(1);
    expect(run.log).toContain(
      'The release succeeded, but the production tags of registry.example.com/web cannot move: this action only authenticates to ghcr.io.',
    );
    expect(run.calls('docker')).toEqual([]);
  });
});

describe('failures before the host is contacted', () => {
  it.each([
    [
      'the OIDC request fails',
      { oidcStatus: 22 },
      'Requesting the GitHub OIDC token failed',
    ],
    [
      'the OIDC response has no JWT',
      { oidcResponse: '{"value":"not a jwt"}' },
      'The GitHub OIDC token response did not contain a JWT',
    ],
    [
      'decryption fails',
      { sopsStatus: 1 },
      'Decrypting ci.app_release.ssh_private_key from secrets/ci.yaml failed',
    ],
    [
      'the stored value is not a private key',
      { sopsOutput: 'ssh-ed25519 AAAA public\n' },
      'ci.app_release.ssh_private_key in secrets/ci.yaml is not a PEM or OpenSSH private key',
    ],
  ] as const)('fails closed when %s', (_label, options, message) => {
    const run = runAction(options);

    expect(run.result.status).toBe(1);
    expect(run.log).toContain(`::error title=App release::${message}`);
    expect(run.log).not.toContain('::add-mask::not a jwt');
    expect(run.calls('ssh')).toEqual([]);
    expect(run.workDirRemains).toBe(false);
  });
});
