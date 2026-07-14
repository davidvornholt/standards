import { describe, expect, it } from 'bun:test';
import { diffEnvironment } from './github-diff';

const declared = JSON.parse(
  '{"name":"standards-sync","wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false},"deployment_branch_policies":[]}',
) as Record<string, unknown>;

describe('diffEnvironment', () => {
  it('accepts the exact declared protected-branch policy', () => {
    expect(
      diffEnvironment(
        declared,
        JSON.parse(
          '{"name":"standards-sync","wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false},"deployment_branch_policies":[],"custom_deployment_protection_rules":[]}',
        ) as Record<string, unknown>,
      ),
    ).toEqual([]);
  });

  it('flags a literal deployment branch', () => {
    expect(
      diffEnvironment(
        declared,
        JSON.parse(
          '{"name":"standards-sync","wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false},"deployment_branch_policies":[{"name":"main","id":1}],"custom_deployment_protection_rules":[]}',
        ) as Record<string, unknown>,
      ),
    ).toEqual([
      'environment "standards-sync": deployment_branch_policies differs from the declared configuration',
    ]);
  });

  it('flags every enabled custom deployment gate as undeclared drift', () => {
    expect(
      diffEnvironment(
        declared,
        JSON.parse(
          '{"name":"standards-sync","wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false},"deployment_branch_policies":[],"custom_deployment_protection_rules":[{"app":{"id":9,"slug":"external-gate"},"id":8}]}',
        ) as Record<string, unknown>,
      ),
    ).toEqual([
      'environment "standards-sync": custom_deployment_protection_rules differs from the declared configuration',
    ]);
  });
});
