import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_SYNC_POLICY, inspectSyncPolicy } from './sync-policy.ts';

const packageText = (version) =>
  JSON.stringify({
    devDependencies: { '@davidvornholt/standards': version },
  });

describe('sync policy controller contract', () => {
  it('rejects unknown policy keys exactly', () => {
    const inspection = inspectSyncPolicy({
      packageText: packageText('0.5.0'),
      policyText: JSON.stringify({
        ...DEFAULT_SYNC_POLICY,
        typo: false,
      }),
    });

    assert.ok(
      inspection.problems.includes(
        'sync-standards.local.json has unknown key "typo"',
      ),
    );
  });

  it('requires a compatible exact package for default policy', () => {
    const inspection = inspectSyncPolicy({
      packageText: packageText('0.4.0'),
      policyText: undefined,
    });

    assert.equal(inspection.problems.length, 1);
    assert.deepEqual(inspection.policy, DEFAULT_SYNC_POLICY);
    assert.ok(inspection.problems[0].includes('exact stable version >=0.5.0'));
  });
});
