import { describe, expect, it } from 'bun:test';
import { decodeCustomProtectionRules } from './github-custom-protection-response';
import {
  decodeEnvironmentResponse,
  decodePolicyPage,
} from './github-environment-response';

const { MAX_SAFE_INTEGER } = Number;
const PREVENT_SELF_REVIEW = 'prevent_self_review';
const TOTAL_COUNT = 'total_count';
const BRANCH_POLICIES = 'branch_policies';
const NODE_ID = 'node_id';

const environment = (protectionRules: unknown): unknown =>
  JSON.parse(
    `{"name":"standards-sync","protection_rules":${JSON.stringify(protectionRules)},"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false}}`,
  ) as unknown;

describe('decodeEnvironmentResponse', () => {
  it('rejects malformed reviewer identities', () => {
    const decoded = decodeEnvironmentResponse(
      environment([
        {
          type: 'required_reviewers',
          [PREVENT_SELF_REVIEW]: false,
          reviewers: [{ type: 'User', reviewer: { id: 0 } }],
        },
      ]),
      'standards-sync',
    );

    expect(decoded).toEqual({
      problem:
        'reading environment "standards-sync": GitHub returned an invalid required-reviewer identity',
      value: null,
    });
  });

  it('preserves the valid null deployment-policy state as driftable data', () => {
    const body = JSON.parse(
      '{"name":"standards-sync","protection_rules":[],"deployment_branch_policy":null}',
    ) as unknown;

    expect(
      decodeEnvironmentResponse(body, 'standards-sync').value?.branchPolicy,
    ).toBeNull();
  });
});

describe('decodePolicyPage', () => {
  it('accepts the official response shape without synthesizing a policy type', () => {
    const decoded = decodePolicyPage(
      {
        [TOTAL_COUNT]: MAX_SAFE_INTEGER,
        [BRANCH_POLICIES]: [
          {
            id: MAX_SAFE_INTEGER,
            [NODE_ID]: 'MDg6R2F0ZTM=',
            name: 'release/*',
          },
        ],
      },
      'production',
    );

    expect(decoded.value).toEqual({
      policies: [{ id: MAX_SAFE_INTEGER, name: 'release/*' }],
      totalCount: MAX_SAFE_INTEGER,
    });
  });

  it('rejects negative or unsafe totals', () => {
    for (const totalCount of [-1, MAX_SAFE_INTEGER + 1]) {
      expect(
        decodePolicyPage(
          { [TOTAL_COUNT]: totalCount, [BRANCH_POLICIES]: [] },
          'production',
        ).problem,
      ).toContain('invalid deployment-policy page');
    }
  });

  it('rejects duplicate policy names as ambiguous live state', () => {
    expect(
      decodePolicyPage(
        {
          [TOTAL_COUNT]: 2,
          [BRANCH_POLICIES]: [
            { id: 1, [NODE_ID]: 'node-1', name: 'main' },
            { id: 2, [NODE_ID]: 'node-2', name: 'main' },
          ],
        },
        'production',
      ).problem,
    ).toContain('duplicate deployment policy name');
  });
});

describe('decodeCustomProtectionRules', () => {
  it('decodes enabled rules with positive-safe rule and app identities', () => {
    const decoded = decodeCustomProtectionRules(
      JSON.parse(
        '{"total_count":1,"custom_deployment_protection_rules":[{"app":{"id":9,"slug":"deployment-gate"},"enabled":true,"id":7}]}',
      ) as unknown,
      'production',
    );

    expect(decoded).toEqual({
      problem: null,
      value: {
        rules: [{ app: { id: 9, slug: 'deployment-gate' }, id: 7 }],
      },
    });
  });

  it('fails closed on malformed counts, ids, enabled state, or app identity', () => {
    const invalidBodies = JSON.parse(
      '[{"total_count":1,"custom_deployment_protection_rules":[]},{"total_count":1,"custom_deployment_protection_rules":[{"app":{"id":9,"slug":"gate"},"enabled":true,"id":0}]},{"total_count":1,"custom_deployment_protection_rules":[{"app":{"id":9,"slug":"gate"},"enabled":false,"id":7}]},{"total_count":1,"custom_deployment_protection_rules":[{"app":{"id":0,"slug":""},"enabled":true,"id":7}]}]',
    ) as ReadonlyArray<unknown>;

    for (const body of invalidBodies) {
      expect(decodeCustomProtectionRules(body, 'production').value).toBeNull();
    }
  });
});
