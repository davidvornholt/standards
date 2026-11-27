// The review check of `standards land`: a pull request lands when a review-fix
// report covers its head, or with a reason it needs none, which land posts on
// the pull request so the decision stays visible. The prs skill describes when
// each applies.

import {
  ghJson,
  type LandContext,
  LandError,
  type Repository,
  run,
  shortSha,
} from './land-context';
import type { SettledHead } from './land-wait';

// The last line of a review-fix report, which names the head it covers.
const REVIEW_LINE = /^Reviewed through (?<sha>[0-9a-f]{40})\.$/u;
// Prints the comments' lines that may be such a line, because all of their
// text can overflow the output that land buffers.
const REVIEW_LINES_JQ =
  '.[].body | split("\\n")[] | select(contains("Reviewed through "))';
const COMMENTS_PER_PAGE = 100;
const MERGE_PARENTS = 2;

export type ReviewRequest = {
  readonly prNumber: number;
  readonly repo: Repository;
  readonly head: string;
  readonly base: string;
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
    REVIEW_LINES_JQ,
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

// Whether the base branch's history contains commit. A failed lookup counts
// as no.
const onBase = (
  context: LandContext,
  { repo, base }: ReviewRequest,
  commit: string,
): boolean => {
  const result = run(
    context,
    'gh',
    [
      'api',
      `repos/${repo.nameWithOwner}/compare/${commit}...${base}`,
      '--jq',
      '.status',
    ],
    false,
  );
  const status = result.stdout.trim();
  return result.status === 0 && (status === 'ahead' || status === 'identical');
};

// Whether head is the reviewed head plus at most updates merge commits on top
// of it, such as land's own updates of the branch make. GitHub's merge commit
// has the old head as its first parent and a commit of the base as its
// second, so a merge of other work doesn't count.
const onlyUpdates = (
  context: LandContext,
  request: ReviewRequest,
  { head, updates }: SettledHead,
): boolean => {
  if (head === request.head) {
    return true;
  }
  if (updates === 0) {
    return false;
  }
  const parents = ghJson<ReadonlyArray<string>>(
    context,
    'api',
    `repos/${request.repo.nameWithOwner}/commits/${head}`,
    '--jq',
    '[.parents[].sha]',
  );
  const [first, second] = parents;
  return (
    parents.length === MERGE_PARENTS &&
    first !== undefined &&
    second !== undefined &&
    onBase(context, request, second) &&
    onlyUpdates(context, request, { head: first, updates: updates - 1 })
  );
};

// Like reviewNote for the head the wait settled on, given the note for the
// head it started from. A report on that head still covers land's own
// updates of the branch with its base, so they need no new review.
export const settledNote = (
  context: LandContext,
  request: ReviewRequest,
  note: string | null,
  settled: SettledHead,
): string | null => {
  if (settled.head === request.head) {
    return note;
  }
  if (note === null && onlyUpdates(context, request, settled)) {
    return null;
  }
  return reviewNote(context, { ...request, head: settled.head });
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
