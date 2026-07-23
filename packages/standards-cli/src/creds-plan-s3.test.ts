import { describe, expect, it } from 'bun:test';
import { computeCredsPlan } from './creds-plan';
import { keys, NOW, REPO, token } from './creds-plan-test-support';

describe('creds plan S3 pair destinations', () => {
  it('renews an S3 pair destination with the s3 format', () => {
    const plan = computeCredsPlan({
      repo: REPO,
      keysByTarget: keys({
        ci: ['ci.r2.access_key_id', 'ci.r2.secret_access_key'],
      }),
      tokens: [
        {
          accountId: 'a',
          token: token(`standards/${REPO}/ci/ci.r2`, '2026-08-01T00:00:00Z'),
        },
      ],
      now: NOW,
    });
    expect(plan.actions).toEqual([
      expect.objectContaining({ kind: 'renew', key: 'ci.r2', format: 's3' }),
    ]);
  });

  it('treats a complete S3 pair as present rather than revoking', () => {
    const plan = computeCredsPlan({
      repo: REPO,
      keysByTarget: keys({
        ci: ['ci.r2.access_key_id', 'ci.r2.secret_access_key'],
      }),
      tokens: [
        {
          accountId: 'a',
          token: token(`standards/${REPO}/ci/ci.r2`, '2027-01-01T00:00:00Z'),
        },
      ],
      now: NOW,
    });
    expect(plan.actions).toEqual([]);
    expect(plan.healthy).toBe(1);
  });

  it('surfaces an incomplete S3 pair instead of revoking or renewing', () => {
    const plan = computeCredsPlan({
      repo: REPO,
      keysByTarget: keys({ ci: ['ci.r2.access_key_id'] }),
      tokens: [
        {
          accountId: 'a',
          token: token(`standards/${REPO}/ci/ci.r2`, '2026-08-01T00:00:00Z'),
        },
      ],
      now: NOW,
    });
    expect(plan.actions).toEqual([]);
    expect(plan.healthy).toBe(0);
    expect(plan.findings).toEqual([
      expect.stringContaining('incomplete S3 credential pair'),
    ]);
  });
});
