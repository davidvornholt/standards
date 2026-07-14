import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SYNC_POLICY,
  inspectSyncPolicy,
  SYNC_POLICY_FILE,
} from './sync-policy.ts';

const consumerPackageText = (version) =>
  JSON.stringify({
    devDependencies: { '@davidvornholt/standards': version },
  });
const hasDependencyProblem = (packageText) =>
  inspectSyncPolicy({ packageText, policyText: undefined }).problems.some(
    (problem) => problem.includes('exact stable version >=0.5.0'),
  );

describe('sync policy controller contract', () => {
  it('rejects unknown policy keys exactly', () => {
    const inspection = inspectSyncPolicy({
      packageText: consumerPackageText('0.5.0'),
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

  it('accepts compatible exact direct development dependencies', () => {
    for (const version of ['0.5.0', '0.9.0', '1.0.0']) {
      const inspection = inspectSyncPolicy({
        packageText: consumerPackageText(version),
        policyText: undefined,
      });
      assert.deepEqual(inspection.problems, []);
      assert.deepEqual(inspection.policy, DEFAULT_SYNC_POLICY);
    }
  });

  it('rejects old, inexact, workspace, misplaced, and missing declarations', () => {
    const invalidPackages = [
      consumerPackageText('0.4.0'),
      consumerPackageText('^0.5.0'),
      consumerPackageText('workspace:*'),
      JSON.stringify({
        dependencies: { '@davidvornholt/standards': '0.5.0' },
      }),
      JSON.stringify({
        name: '@davidvornholt/standards',
        version: '0.5.0',
        bin: { standards: 'src/cli.ts' },
      }),
    ];

    assert.deepEqual(
      invalidPackages.map(hasDependencyProblem),
      Array.from({ length: invalidPackages.length }, () => true),
    );
  });
});
