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
const sourceRootText = (overrides = {}) =>
  JSON.stringify({
    name: 'standards',
    private: true,
    workspaces: ['packages/*'],
    standardsSourceWorkspace: {
      path: 'packages/standards-cli',
      syncPolicyContractVersion: 1,
    },
    ...overrides,
  });
const sourcePackageText = (overrides = {}) =>
  JSON.stringify({
    name: '@davidvornholt/standards',
    version: '0.5.0',
    repository: { directory: 'packages/standards-cli' },
    bin: { standards: 'src/cli.ts' },
    exports: {},
    ...overrides,
  });

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

  it('requires a compatible exact package for default policy', () => {
    const inspection = inspectSyncPolicy({
      packageText: consumerPackageText('0.4.0'),
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
      sourceWorkspacePackageText: sourcePackageText(),
    });

    assert.ok(inspection.problems[0].includes('exact stable version >=0.5.0'));
  });

  it('recognizes the versioned source capability without owning scripts', () => {
    const inspection = inspectSyncPolicy({
      packageText: sourceRootText({ scripts: { standards: 'rewritten' } }),
      policyText: undefined,
      sourceWorkspacePackageText: sourcePackageText(),
    });

    assert.deepEqual(inspection.problems, []);
  });

  it('requires every semantic source identity relationship', () => {
    const invalidFixtures = [
      [sourceRootText({ name: 'standards-lookalike' }), sourcePackageText()],
      [sourceRootText({ private: false }), sourcePackageText()],
      [sourceRootText({ workspaces: ['apps/*'] }), sourcePackageText()],
      [
        sourceRootText({
          standardsSourceWorkspace: {
            path: 'packages/standards-cli',
            syncPolicyContractVersion: 2,
          },
        }),
        sourcePackageText(),
      ],
      [sourceRootText(), sourcePackageText({ name: 'standards-lookalike' })],
      [sourceRootText(), sourcePackageText({ version: '^0.5.0' })],
      [sourceRootText(), sourcePackageText({ repository: {} })],
      [sourceRootText(), sourcePackageText({ bin: {} })],
      [
        sourceRootText(),
        sourcePackageText({ exports: { '.': './src/cli.ts' } }),
      ],
    ];

    for (const [packageText, sourceWorkspacePackageText] of invalidFixtures) {
      const inspection = inspectSyncPolicy({
        packageText,
        policyText: undefined,
        sourceWorkspacePackageText,
      });
      assert.equal(inspection.problems.length, 1);
      assert.ok(
        inspection.problems[0].includes('exact stable version >=0.5.0'),
      );
    }
  });
});
