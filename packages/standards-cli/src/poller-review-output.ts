import { Buffer } from 'node:buffer';
import { isRecord } from './github-settings-parse';
import type { DeferredFinding } from './poller-protocol';
import { runGit } from './poller-workspace';

const REVIEW_OUTPUT_MARKER = '<!-- standards-poller:review-output\n';
const REVIEW_OUTPUT_END = '\n-->';
const REVIEW_COMMIT_MARKER = 'standards-poller:review-output';
const APPROVAL_ID_LENGTH = 12;

export type ReviewPublicationPlan = {
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
      typeof raw.approvalId !== 'string' ||
      typeof raw.approvedHead !== 'string' ||
      typeof raw.publishedHead !== 'string' ||
      typeof raw.baseRef !== 'string' ||
      typeof raw.baseSha !== 'string' ||
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
  prNumber: number,
  approvalId: string,
): string =>
  `poller/review-pr-${prNumber}-${approvalId.slice(0, APPROVAL_ID_LENGTH)}`;

const commitMessage = (plan: ReviewPublicationPlan): string =>
  `${REVIEW_COMMIT_MARKER}\n${Buffer.from(JSON.stringify(plan)).toString('base64url')}`;

export const sealReviewPlan = (
  workDir: string,
  plan: ReviewPublicationPlan,
): string => {
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
    return encoded === undefined
      ? null
      : parseReviewPlan(
          `${REVIEW_OUTPUT_MARKER}${encoded}${REVIEW_OUTPUT_END}`,
        );
  } catch {
    return null;
  }
};
