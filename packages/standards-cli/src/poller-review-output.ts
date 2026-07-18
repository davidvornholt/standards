import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { isRecord } from './github-settings-parse';
import {
  assertCleanOutputWorktree,
  commitCountBetween,
  isAncestor,
  isGitObjectId,
  singleParentOf,
} from './poller-output-integrity';
import type { DeferredFinding } from './poller-protocol';
import { runGit } from './poller-workspace';

const REVIEW_OUTPUT_MARKER = '<!-- standards-poller:review-output\n';
const REVIEW_OUTPUT_END = '\n-->';
const REVIEW_COMMIT_MARKER = 'standards-poller:review-output';
const OUTPUT_BRANCH_DIGEST_LENGTH = 16;

export type ReviewPublicationPlan = {
  readonly repo: string;
  readonly prNumber: number;
  readonly approvalId: string;
  readonly approvedHead: string;
  readonly publishedHead: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly report: string;
  readonly commits: number;
  readonly deferred: ReadonlyArray<DeferredFinding>;
};

const isDeferredFinding = (value: unknown): value is DeferredFinding =>
  isRecord(value) &&
  typeof value.title === 'string' &&
  value.title.length > 0 &&
  typeof value.body === 'string' &&
  value.body.length > 0;

export const reviewPlanMarker = (plan: ReviewPublicationPlan): string =>
  `${REVIEW_OUTPUT_MARKER}${Buffer.from(JSON.stringify(plan)).toString('base64url')}${REVIEW_OUTPUT_END}`;

export const parseReviewPlan = (body: string): ReviewPublicationPlan | null => {
  const start = body.lastIndexOf(REVIEW_OUTPUT_MARKER);
  if (start < 0) {
    return null;
  }
  const encodedStart = start + REVIEW_OUTPUT_MARKER.length;
  const end = body.indexOf(REVIEW_OUTPUT_END, encodedStart);
  if (end < 0) {
    return null;
  }
  try {
    const raw = JSON.parse(
      Buffer.from(body.slice(encodedStart, end), 'base64url').toString('utf8'),
    ) as unknown;
    if (
      !isRecord(raw) ||
      typeof raw.repo !== 'string' ||
      typeof raw.prNumber !== 'number' ||
      typeof raw.approvalId !== 'string' ||
      typeof raw.approvedHead !== 'string' ||
      typeof raw.publishedHead !== 'string' ||
      typeof raw.baseRef !== 'string' ||
      typeof raw.baseSha !== 'string' ||
      !isGitObjectId(raw.approvedHead) ||
      !isGitObjectId(raw.publishedHead) ||
      !isGitObjectId(raw.baseSha) ||
      typeof raw.report !== 'string' ||
      typeof raw.commits !== 'number' ||
      !Number.isInteger(raw.commits) ||
      raw.commits < 0 ||
      !Array.isArray(raw.deferred) ||
      !raw.deferred.every(isDeferredFinding)
    ) {
      return null;
    }
    return raw as ReviewPublicationPlan;
  } catch {
    return null;
  }
};

export const reviewOutputBranch = (
  identity: Pick<
    ReviewPublicationPlan,
    'repo' | 'prNumber' | 'baseSha' | 'approvedHead' | 'approvalId'
  >,
): string => {
  const { repo, prNumber, baseSha, approvedHead, approvalId } = identity;
  const generation = createHash('sha256')
    .update(
      JSON.stringify({ repo, prNumber, baseSha, approvedHead, approvalId }),
    )
    .digest('hex')
    .slice(0, OUTPUT_BRANCH_DIGEST_LENGTH);
  return `poller/review-pr-${prNumber}-${generation}`;
};

const commitMessage = (plan: ReviewPublicationPlan): string =>
  `${REVIEW_COMMIT_MARKER}\n${Buffer.from(JSON.stringify(plan)).toString('base64url')}`;

export const sealReviewPlan = (
  workDir: string,
  plan: ReviewPublicationPlan,
): string => {
  assertCleanOutputWorktree(workDir);
  const publishedHead = runGit(
    ['-C', workDir, 'rev-parse', 'HEAD'],
    null,
  ).trim();
  if (
    publishedHead !== plan.publishedHead ||
    !isAncestor(workDir, plan.approvedHead, plan.publishedHead) ||
    commitCountBetween(workDir, plan.approvedHead, plan.publishedHead) !==
      plan.commits
  ) {
    throw new Error('refusing to seal a review plan for a different history');
  }
  runGit(
    [
      '-C',
      workDir,
      '-c',
      'user.name=standards-poller',
      '-c',
      'user.email=standards-poller@users.noreply.github.com',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '--allow-empty',
      '--only',
      '-m',
      commitMessage(plan),
    ],
    null,
  );
  return runGit(['-C', workDir, 'rev-parse', 'HEAD'], null).trim();
};

export const readSealedReviewPlan = (
  cloneDir: string,
  branch: string,
): ReviewPublicationPlan | null => {
  try {
    const sealedHead = runGit(
      ['-C', cloneDir, 'rev-parse', `refs/heads/${branch}`],
      null,
    ).trim();
    const changed = runGit(
      [
        '-C',
        cloneDir,
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        sealedHead,
      ],
      null,
    ).trim();
    const [marker, encoded] = runGit(
      ['-C', cloneDir, 'log', '-1', '--format=%B', sealedHead],
      null,
    )
      .trim()
      .split('\n');
    if (changed.length > 0 || marker !== REVIEW_COMMIT_MARKER) {
      return null;
    }
    const plan =
      encoded === undefined
        ? null
        : parseReviewPlan(
            `${REVIEW_OUTPUT_MARKER}${encoded}${REVIEW_OUTPUT_END}`,
          );
    if (
      plan === null ||
      singleParentOf(cloneDir, sealedHead) !== plan.publishedHead ||
      !isAncestor(cloneDir, plan.approvedHead, plan.publishedHead) ||
      commitCountBetween(cloneDir, plan.approvedHead, plan.publishedHead) !==
        plan.commits
    ) {
      return null;
    }
    return plan;
  } catch {
    return null;
  }
};
