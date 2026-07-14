import { describe, expect, it } from 'bun:test';
import {
  decodeEnvironmentResponse,
  decodePolicyPage,
} from './github-environment-response';

const { MAX_SAFE_INTEGER } = Number;
const PREVENT_SELF_REVIEW = 'prevent_self_review';
const TOTAL_COUNT = 'total_count';
const BRANCH_POLICIES = 'branch_policies';

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
  it('accepts positive safe ids and nonnegative safe totals at the boundary', () => {
    const decoded = decodePolicyPage(
      {
        [TOTAL_COUNT]: MAX_SAFE_INTEGER,
        [BRANCH_POLICIES]: [
          { id: MAX_SAFE_INTEGER, name: 'release/*', type: 'tag' },
        ],
      },
      'production',
    );

    expect(decoded.value).not.toBeNull();
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
});
