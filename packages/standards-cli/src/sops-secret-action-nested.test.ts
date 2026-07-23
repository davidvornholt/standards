import { afterEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { cleanupTmpDirs } from './cli-test-support';
import { createSopsActionRunner } from './sops-secret-action-test-support';

const runSopsAction = createSopsActionRunner(process.env);

afterEach(cleanupTmpDirs);

describe('nested SOPS secret action values', () => {
  it('transports and masks a multiline broker private key without a secret output', () => {
    const privateKey =
      '-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----\n';
    const actionRun = runSopsAction({
      failureMode: 'fail',
      secretKey: 'broker_app.private_key',
      sopsOutput: `{"ci":{"broker_app":{"app_id":"12345","private_key":${JSON.stringify(privateKey)}}}}`,
    });

    expect(actionRun.result.status).toBe(0);
    expect(actionRun.environment).toBe(
      `GH_TOKEN<<SOPS_SECRET_EOF\n${privateKey}\nSOPS_SECRET_EOF\n`,
    );
    expect(actionRun.result.stdout).toBe(
      [
        '::add-mask::-----BEGIN RSA PRIVATE KEY-----',
        '::add-mask::key',
        '::add-mask::-----END RSA PRIVATE KEY-----',
        '',
      ].join('\n'),
    );
    expect(actionRun.output).toBe('used-fallback=false\n');
    expect(actionRun.output).not.toContain(privateKey);
  });

  it.each([
    [
      'a missing nested path',
      '{"ci":{"broker_app":{}}}',
      'ci.broker_app.private_key is missing in secrets/ci.yaml',
    ],
    [
      'ambiguous direct and nested values',
      '{"ci":{"broker_app.private_key":"direct-key","broker_app":{"private_key":"nested-key"}}}',
      'ci.broker_app.private_key is ambiguous because both a direct key and nested path exist in secrets/ci.yaml',
    ],
    [
      'a non-string nested value',
      '{"ci":{"broker_app":{"private_key":{"encrypted":true}}}}',
      'ci.broker_app.private_key is not a string in secrets/ci.yaml',
    ],
  ] as const)('fails closed for %s', (_label, sopsOutput, reason) => {
    const actionRun = runSopsAction({
      failureMode: 'fail',
      secretKey: 'broker_app.private_key',
      sopsOutput,
    });

    expect(actionRun.result.status).toBe(1);
    expect(actionRun.environment).toBe('');
    expect(actionRun.output).toBe('');
    expect(`${actionRun.result.stdout}${actionRun.result.stderr}`).toContain(
      `::error::${reason}`,
    );
  });
});
