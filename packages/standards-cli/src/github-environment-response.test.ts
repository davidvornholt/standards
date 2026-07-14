import { describe, expect, it } from 'bun:test';
import { decodeCustomProtectionRules } from './github-custom-protection-response';
import { decodeEnvironmentResponse } from './github-environment-response';

const PREVENT_SELF_REVIEW = 'prevent_self_review';

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

  it('preserves live custom branch mode as driftable data', () => {
    const body = JSON.parse(
      '{"name":"standards-sync","protection_rules":[],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}',
    ) as unknown;

    expect(
      decodeEnvironmentResponse(body, 'standards-sync').value?.branchPolicy,
    ).toEqual(
      JSON.parse('{"protected_branches":false,"custom_branch_policies":true}'),
    );
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
