// Runs the real login command in a child process to protect the operator
// guidance semantically: the account-scoped dashboard URL and the required
// "Create additional tokens" template step must be printed, the obsolete
// custom-token step must not, and a failed verification must never create
// the broker store.

import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const ACCOUNT_ID_LENGTH = 32;
const ACCOUNT = 'a'.repeat(ACCOUNT_ID_LENGTH);
const TOKEN = 'cfat_bootstrap_secret';
const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('Cloudflare login command output', () => {
  it('prints the required setup guidance without storing an invalid token', () => {
    const directory = mkdtempSync(join(tmpdir(), 'creds-login-cloudflare-'));
    temporaryDirectories.push(directory);
    const brokerPath = join(directory, 'broker.yaml');
    const moduleUrl = new URL('./creds-login-cloudflare.ts', import.meta.url)
      .href;
    const script = `globalThis.fetch = (input) => Promise.resolve(String(input).endsWith('/verify')
      ? Response.json({ success: true, errors: [], result: { status: 'active' } })
      : Response.json({ success: true, errors: [], result: [], result_info: { page: 1, per_page: 50, count: 0, total_count: 0 } }));
      const { runCredsLoginCloudflare } = await import(${JSON.stringify(moduleUrl)});
      const ok = await runCredsLoginCloudflare({ account: ${JSON.stringify(ACCOUNT)} });
      process.exitCode = ok ? 0 : 1;`;
    const run = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: Process environment keys are uppercase.
        PATH: '',
        // biome-ignore lint/style/useNamingConvention: Process environment keys are uppercase.
        STANDARDS_BROKER_FILE: brokerPath,
      },
      input: `${TOKEN}\n`,
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(
      `https://dash.cloudflare.com/${ACCOUNT}/api-tokens`,
    );
    expect(run.stdout).toContain('Create additional tokens');
    expect(run.stdout).not.toContain('Create Custom Token');
    expect(run.stderr).toContain(
      'token verification returned no valid token ID',
    );
    expect(existsSync(brokerPath)).toBe(false);
  });
});
