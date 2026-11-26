// The review check of `standards land`: a pull request lands when a review-fix
// report covers its head, or with a reason it needs none, which land posts on
// the pull request so the decision stays visible. The prs skill describes when
// each applies.

import {
  type LandContext,
  LandError,
  type Repository,
  run,
  shortSha,
} from './land-context';

// The last line of a review-fix report, which names the head it covers.
const REVIEW_LINE = /^Reviewed through (?<sha>[0-9a-f]{40})\.$/u;
const COMMENTS_PER_PAGE = 100;

export type ReviewRequest = {
  readonly prNumber: number;
  readonly repo: Repository;
  readonly head: string;
  // Why the pull request needs no review-fix, or null without --no-review.
  readonly noReview: string | null;
};

// The heads that review-fix reports on the pull request cover.
const reviewedHeads = (
  context: LandContext,
  { prNumber, repo }: ReviewRequest,
): ReadonlySet<string> => {
  const { stdout } = run(context, 'gh', [
    'api',
    `repos/${repo.nameWithOwner}/issues/${prNumber}/comments?per_page=${COMMENTS_PER_PAGE}`,
    '--paginate',
    '--jq',
    '.[].body',
  ]);
  return new Set(
    stdout
      .split('\n')
      .map((line) => REVIEW_LINE.exec(line.trim())?.groups?.sha)
      .filter((sha) => sha !== undefined),
  );
};

// Returns the comment to post before merging, or null when a review-fix
// report covers the head. Throws when neither a report nor a reason is there.
export const reviewNote = (
  context: LandContext,
  request: ReviewRequest,
): string | null => {
  if (reviewedHeads(context, request).has(request.head)) {
    return null;
  }
  if (request.noReview !== null) {
    return `Landing without review-fix: ${request.noReview}`;
  }
  throw new LandError(
    `No review-fix report covers head ${shortSha(request.head)} of PR #${request.prNumber}. ` +
      'If a reviewer could find a bug in it that someone would otherwise run into, run the review-fix skill. ' +
      'Otherwise pass --no-review "<why it needs none>".',
  );
};

export const postNote = (
  context: LandContext,
  { prNumber, repo }: ReviewRequest,
  note: string,
): void => {
  run(context, 'gh', [
    'pr',
    'comment',
    String(prNumber),
    '--repo',
    repo.url,
    '--body',
    note,
  ]);
};
