import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SYNC_POLICY,
  inspectSyncPolicy,
  SYNC_POLICY_FILE,
} from './sync-policy.ts';

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
        `${SYNC_POLICY_FILE} has unknown key "typo"`,
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

  it('does not waive consumer dependency checks for a package-name lookalike', () => {
    const inspection = inspectSyncPolicy({
      packageText: JSON.stringify({ name: 'standards', private: true }),
      policyText: undefined,
      sourceWorkspacePackageText: packageText('0.5.0'),
    });

    assert.ok(inspection.problems[0].includes('exact stable version >=0.5.0'));
  });
});
