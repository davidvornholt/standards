import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseReviewPlan,
  type ReviewPublicationPlan,
  readSealedReviewPlan,
  reviewPlanMarker,
  sealReviewPlan,
} from './poller-review-output';

const dirs: Array<string> = [];
const plan: ReviewPublicationPlan = {
  approvalId: 'approval',
  approvedHead: 'old',
  publishedHead: 'new',
  baseRef: 'main',
  baseSha: 'base',
  report: 'Reviewed.',
  commits: 1,
  deferred: [{ title: 'Follow up', body: 'Evidence.' }],
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('review publication output', () => {
  it('round-trips the comment marker and sealed branch tip', () => {
    expect(parseReviewPlan(reviewPlanMarker(plan))).toEqual(plan);
    const root = mkdtempSync(join(tmpdir(), 'poller-review-output-'));
    dirs.push(root);
    execFileSync('git', ['init', '-q', root]);
    writeFileSync(join(root, 'file.txt'), 'initial\n');
    execFileSync('git', ['-C', root, 'add', 'file.txt']);
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-qm',
      'initial',
    ]);
    execFileSync('git', ['-C', root, 'branch', '-M', 'sealed']);
    sealReviewPlan(root, plan);
    expect(readSealedReviewPlan(root, 'sealed')).toEqual(plan);
  });

  it('rejects malformed markers', () => {
    expect(parseReviewPlan('no marker')).toBeNull();
    expect(
      parseReviewPlan('<!-- standards-poller:review-output\nbm90LWpzb24\n-->'),
    ).toBeNull();
  });
});
