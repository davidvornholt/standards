import { describe, expect, it } from 'bun:test';
import { environmentListProblems } from './github-environment-settings';

const MAX_ENVIRONMENT_NAME_LENGTH = 255;
const MAX_WAIT_TIMER = 43_200;
const MAX_REVIEWERS = 6;
const EXPECTED_PROBLEM_COUNT = 14;
const WAIT_TIMER = 'wait_timer';
const PREVENT_SELF_REVIEW = 'prevent_self_review';
const DEPLOYMENT_BRANCH_POLICY = 'deployment_branch_policy';
const DEPLOYMENT_BRANCH_POLICIES = 'deployment_branch_policies';

const validEnvironment = (name: string): Record<string, unknown> => ({
  ...JSON.parse(
    '{"wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false},"deployment_branch_policies":[]}',
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
        id: index + 1,
      })),
    };

    expect(environmentListProblems([environment], 'settings')).toEqual([]);
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
      [DEPLOYMENT_BRANCH_POLICIES]: [
        { name: 'main', type: 'branch', extra: true },
        { name: 'main', type: 'branch', duplicate: true },
        { name: '', type: 'commit', pattern: '*' },
        null,
      ],
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
      'settings environments[0] declares deployment policy "main" more than once',
    );
    expect(problems).toContain(
      'settings environments[0].deployment_branch_policies[2] has unknown key "pattern"',
    );
    expect(problems).toContain(
      'settings environments[0].deployment_branch_policies[3] must have a non-empty name and type "branch" or "tag"',
    );
  });
});
