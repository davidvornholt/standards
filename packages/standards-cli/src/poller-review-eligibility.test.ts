import { expect, it } from 'bun:test';
import type { PullRequest } from './poller-github-pulls';
import { reviewEligibility } from './poller-review-eligibility';

const REPO = 'owner/repo';

const pullRequest = (draft: boolean, headRepo = REPO): PullRequest => ({
  number: 7,
  title: 'Title',
  body: 'Body',
  headRef: 'feature',
  headSha: 'head',
  headRepo,
  baseRef: 'main',
  baseSha: 'base',
  nodeId: 'PR_node',
  draft,
});

it.each([
  ['draft same-repository PR', pullRequest(true), false, 'eligible'],
  ['persisted plan', pullRequest(true), true, 'recovering'],
  ['ready PR without a plan', pullRequest(false), false, 'rejected'],
  ['ready PR with a plan', pullRequest(false), true, 'recovering'],
  ['fork PR', pullRequest(true, 'contributor/repo'), false, 'rejected'],
] as const)('classifies a %s', (_description, pr, hasPlan, expected) => {
  expect(reviewEligibility({ repo: REPO, pr, hasPlan }).kind).toBe(expected);
});
