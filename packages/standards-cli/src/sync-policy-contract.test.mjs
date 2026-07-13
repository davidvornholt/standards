import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspectSyncPolicy } from '../../../.github/actions/standards-sync-preflight/sync-policy.mjs';

const packageText = (version) =>
  JSON.stringify({
    devDependencies: { '@davidvornholt/standards': version },
  });

describe('sync policy controller contract', () => {
  it('rejects unknown policy keys exactly', () => {
    const inspection = inspectSyncPolicy({
      packageText: packageText('0.5.0'),
      policyText: JSON.stringify({
        ref: 'refs/heads/main',
        scheduledSync: true,
        typo: false,
      }),
      requireDirectPackage: true,
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
      requireDirectPackage: true,
    });

    assert.equal(inspection.problems.length, 1);
    assert.ok(inspection.problems[0].includes('exact stable version >=0.5.0'));
  });
});
