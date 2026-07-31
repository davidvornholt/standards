import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { stubRefreshFailureCloudflare } from './creds-plan-refresh-failure-cloudflare-test-support';
import {
  cleanupRefreshFailureFixture,
  refreshFailureFixture,
} from './creds-plan-refresh-failure-test-support';
import { runCredsPlan } from './creds-plan-run';

afterEach(cleanupRefreshFailureFixture);

describe('creds apply refresh after partial failure', () => {
  it('refreshes every committed renewal when a concurrent renewal fails', async () => {
    const setup = refreshFailureFixture(['ci', 'r2']);
    stubRefreshFailureCloudflare(['ci', 'r2'], { create: 'r2' });
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runCredsPlan(setup.consumer, true)).toBe(false);
    const generated = readFileSync(setup.destination, 'utf8');
    expect(generated).toContain('CI_ACCESS_KEY_ID=');
    expect(generated).toContain('newci');
    expect(generated).toContain('R2_ACCESS_KEY_ID=');
    expect(generated).toContain('oldr2');
    expect(generated).not.toContain('STALE=true');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('creation failed'),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('regenerating dev env files'),
    );
  });

  it('refreshes a verified replacement when old-token revocation fails', async () => {
    const setup = refreshFailureFixture(['ci']);
    stubRefreshFailureCloudflare(['ci'], { revoke: 'ci' });
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runCredsPlan(setup.consumer, true)).toBe(false);
    const generated = readFileSync(setup.destination, 'utf8');
    expect(generated).toContain('CI_ACCESS_KEY_ID=');
    expect(generated).toContain('newci');
    expect(generated).not.toContain('STALE=true');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        'replacement newci is stored, but old token oldci could not be revoked',
      ),
    );
  });
});
