import { describe, expect, it } from 'bun:test';
import {
  type GithubReleaseState,
  githubReconciliationPlan,
  npmReleasePlan,
} from './release-recovery';

const SHA = '1234567890abcdef1234567890abcdef12345678';
const MISMATCHED_SHA = 'ffffffffffffffffffffffffffffffffffffffff';

describe('npm release state', () => {
  it.each([
    {
      label: 'existing behind latest',
      version: '0.13.0',
      latest: '0.14.0',
      exactVersionExists: true,
      action: 'recover',
    },
    {
      label: 'existing equal to latest',
      version: '0.14.0',
      latest: '0.14.0',
      exactVersionExists: true,
      action: 'recover',
    },
    {
      label: 'absent newer than latest',
      version: '0.15.0',
      latest: '0.14.0',
      exactVersionExists: false,
      action: 'publish',
    },
    {
      label: 'normal new publish',
      version: '0.14.0',
      latest: '0.13.0',
      exactVersionExists: false,
      action: 'publish',
    },
  ] as const)('$label plans $action', (fixture) => {
    expect(
      npmReleasePlan(
        fixture.version,
        fixture.latest,
        fixture.exactVersionExists,
      ),
    ).toEqual({
      action: fixture.action,
      problem: null,
    });
  });

  it('rejects an absent version behind latest as an out-of-order publish', () => {
    const plan = npmReleasePlan('0.13.0', '0.14.0', false);
    expect(plan.action).toBeNull();
    expect(plan.problem).toContain('behind npm latest');
  });
});

describe('GitHub release reconciliation', () => {
  it.each([
    ['missing', null, 'create'],
    ['tag-only', SHA, 'create'],
    ['published', SHA, 'none'],
  ] as const)('plans %s state with the expected tag SHA', (state, tagSha, action) => {
    expect(githubReconciliationPlan(state, tagSha, SHA)).toEqual({
      action,
      problem: null,
    });
  });

  it.each([
    'tag-only',
    'published',
  ] as const)('rejects an existing %s SHA mismatch', (state: GithubReleaseState) => {
    const plan = githubReconciliationPlan(state, MISMATCHED_SHA, SHA);
    expect(plan.action).toBeNull();
    expect(plan.problem).toContain(`expected ${SHA}`);
  });

  it('rejects an existing draft release', () => {
    expect(githubReconciliationPlan('draft', SHA, SHA).problem).toContain(
      'draft',
    );
  });
});
