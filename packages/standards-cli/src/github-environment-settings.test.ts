import { describe, expect, it } from 'bun:test';
import { environmentListProblems } from './github-environment-settings';

const MAX_ENVIRONMENT_NAME_LENGTH = 255;
const MAX_WAIT_TIMER = 43_200;
const MAX_REVIEWERS = 6;
const EXPECTED_PROBLEM_COUNT = 9;
const WAIT_TIMER = 'wait_timer';
const PREVENT_SELF_REVIEW = 'prevent_self_review';
const DEPLOYMENT_BRANCH_POLICY = 'deployment_branch_policy';
const DEPLOYMENT_BRANCH_POLICIES = 'deployment_branch_policies';
const PROTECTED_BRANCHES = 'protected_branches';
const CUSTOM_BRANCH_POLICIES = 'custom_branch_policies';

const validEnvironment = (name: string): Record<string, unknown> => ({
  ...JSON.parse(
    '{"wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false}}',
  ),
  name,
});

describe('environmentListProblems', () => {
  it('accepts every GitHub environment limit at its upper boundary', () => {
    const environment = {
      ...validEnvironment('e'.repeat(MAX_ENVIRONMENT_NAME_LENGTH)),
      [WAIT_TIMER]: MAX_WAIT_TIMER,
      reviewers: Array.from({ length: MAX_REVIEWERS }, (_, index) => ({
        type: 'User',
        id: index === MAX_REVIEWERS - 1 ? Number.MAX_SAFE_INTEGER : index + 1,
      })),
    };

    expect(environmentListProblems([environment], 'settings')).toEqual([]);
  });

  it('rejects nonpositive and unsafe reviewer identities', () => {
    for (const id of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      const environment = {
        ...validEnvironment('standards-sync'),
        reviewers: [{ type: 'User', id }],
      };

      expect(environmentListProblems([environment], 'settings')).toEqual([
        'settings environments[0].reviewers[0] must have type "User" or "Team" and a positive safe integer id',
      ]);
    }
  });

  it('rejects values above every GitHub environment limit', () => {
    const environment = {
      ...validEnvironment('e'.repeat(MAX_ENVIRONMENT_NAME_LENGTH + 1)),
      [WAIT_TIMER]: MAX_WAIT_TIMER + 1,
      reviewers: Array.from({ length: MAX_REVIEWERS + 1 }, (_, index) => ({
        type: 'User',
        id: index + 1,
      })),
    };

    expect(environmentListProblems([environment], 'settings')).toEqual([
      'settings environments[0].name must be a non-empty string of at most 255 characters',
      'settings environments[0].wait_timer must be an integer from 0 to 43200',
      'settings environments[0].reviewers must contain at most 6 entries',
    ]);
  });

  it('gathers every inspectable nested and duplicate problem', () => {
    const environment = {
      ...validEnvironment('standards-sync'),
      typo: true,
      [WAIT_TIMER]: -1,
      [PREVENT_SELF_REVIEW]: 'no',
      reviewers: [
        { type: 'Robot', id: 'one', login: 'ignored' },
        ...Array.from({ length: MAX_REVIEWERS }, (_, index) => ({
          type: 'User',
          id: index + 2,
        })),
      ],
      [DEPLOYMENT_BRANCH_POLICY]: JSON.parse(
        '{"protected_branches":true,"custom_branch_policies":true,"typo":false}',
      ),
      [DEPLOYMENT_BRANCH_POLICIES]: [{ name: 'main' }],
    };

    const problems = environmentListProblems([environment], 'settings');

    expect(problems).toHaveLength(EXPECTED_PROBLEM_COUNT);
    expect(problems).toContain(
      'settings environments[0] has unknown key "typo"',
    );
    expect(problems).toContain(
      'settings environments[0].reviewers must contain at most 6 entries',
    );
    expect(problems).toContain(
      'settings environments[0].reviewers[0] has unknown key "login"',
    );
    expect(problems).toContain(
      'settings environments[0].deployment_branch_policy has unknown key "typo"',
    );
    expect(problems).toContain(
      'settings environments[0] has unknown key "deployment_branch_policies"',
    );
  });

  it('rejects custom branch mode and deployment policy declarations', () => {
    const environment = {
      ...validEnvironment('standards-sync'),
      [DEPLOYMENT_BRANCH_POLICY]: {
        [PROTECTED_BRANCHES]: false,
        [CUSTOM_BRANCH_POLICIES]: true,
      },
      [DEPLOYMENT_BRANCH_POLICIES]: [{ name: 'main', type: 'branch' }],
    };

    expect(environmentListProblems([environment], 'settings')).toEqual([
      'settings environments[0] has unknown key "deployment_branch_policies"',
      'settings environments[0].deployment_branch_policy must enable protected branches only',
    ]);
  });
});
