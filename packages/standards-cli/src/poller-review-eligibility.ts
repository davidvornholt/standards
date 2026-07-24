import type { PullRequest } from './poller-github-pulls';

export type ReviewEligibility =
  | { readonly kind: 'eligible' }
  | { readonly kind: 'recovering' }
  | {
      readonly kind: 'rejected';
      readonly message: string;
      readonly result: string;
    };

export const reviewEligibility = (options: {
  readonly repo: string;
  readonly pr: PullRequest;
  readonly hasPlan: boolean;
}): ReviewEligibility => {
  const { repo, pr, hasPlan } = options;
  if (!(pr.draft || hasPlan)) {
    return {
      kind: 'rejected',
      message: 'automated review requires a draft PR',
      result: 'rejected (not draft)',
    };
  }
  if (pr.headRepo !== repo) {
    return {
      kind: 'rejected',
      message: `this PR's head branch lives in ${pr.headRepo || 'an unknown repository'}; automated review runs only support same-repository branches`,
      result: 'rejected (fork head)',
    };
  }
  return { kind: hasPlan ? 'recovering' : 'eligible' };
};
