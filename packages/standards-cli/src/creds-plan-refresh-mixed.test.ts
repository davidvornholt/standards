import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  refreshMixedCloudflareCalls,
  stubRefreshMixedCloudflare,
} from './creds-plan-refresh-mixed-cloudflare-test-support';
import {
  cleanupRefreshMixedFixture,
  refreshMixedFixture,
} from './creds-plan-refresh-mixed-test-support';
import { runCredsPlan } from './creds-plan-run';

const EMPTY_EXPANSION = ['$', '{:-}'].join('');

afterEach(cleanupRefreshMixedFixture);

describe('creds apply destination-granular dev env refresh', () => {
  it('does not let a verified bearer sibling render an unsafe S3 pair', async () => {
    const setup = refreshMixedFixture('bearer-s3');
    stubRefreshMixedCloudflare('bearer-s3');
    spyOn(console, 'error').mockImplementation(() => undefined);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    const before = readFileSync(setup.destination, 'utf8');

    expect(await runCredsPlan(setup.consumer, true)).toBe(false);
    expect(readFileSync(setup.destination, 'utf8')).toBe(before);
    expect(refreshMixedCloudflareCalls()).toContain('delete-new-bad');
    expect(refreshMixedCloudflareCalls()).toContain('delete-old-api');
    expect(log.mock.calls.join(' ')).not.toContain(
      'regenerating dev env files',
    );
  });

  it('updates a verified S3 sibling while preserving the unsafe pair', async () => {
    const setup = refreshMixedFixture('sibling-s3');
    stubRefreshMixedCloudflare('sibling-s3');
    spyOn(console, 'error').mockImplementation(() => undefined);
    spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runCredsPlan(setup.consumer, true)).toBe(false);
    const generated = readFileSync(setup.destination, 'utf8');
    expect(generated).toContain(`BAD_ACCESS_KEY_ID=${EMPTY_EXPANSION}old-bad#`);
    expect(generated).toContain(
      `GOOD_ACCESS_KEY_ID=${EMPTY_EXPANSION}new-good#`,
    );
    expect(generated).not.toContain('concurrent-bad');
    expect(refreshMixedCloudflareCalls()).toContain('delete-new-bad');
    expect(refreshMixedCloudflareCalls()).toContain('delete-old-good');
    expect(refreshMixedCloudflareCalls()).not.toContain('delete-old-bad');
  });

  it('preserves a previously unsafe pair when its sibling later commits', async () => {
    const setup = refreshMixedFixture('preexisting-unsafe-s3');
    stubRefreshMixedCloudflare('preexisting-unsafe-s3');
    spyOn(console, 'error').mockImplementation(() => undefined);
    spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runCredsPlan(setup.consumer, true)).toBe(false);
    const generated = readFileSync(setup.destination, 'utf8');
    expect(generated).toContain(`BAD_ACCESS_KEY_ID=${EMPTY_EXPANSION}old-bad#`);
    expect(generated).toContain(
      `GOOD_ACCESS_KEY_ID=${EMPTY_EXPANSION}new-good#`,
    );
    expect(refreshMixedCloudflareCalls()).not.toContain('create-bad');
    expect(refreshMixedCloudflareCalls()).toContain('delete-old-good');
  });
});
