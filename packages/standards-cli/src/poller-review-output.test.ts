import { afterEach, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  repo: 'owner/repo',
  prNumber: 4,
  approvalId: 'approval',
  approvedHead: '1111111111111111111111111111111111111111',
  publishedHead: '2222222222222222222222222222222222222222',
  baseRef: 'main',
  baseSha: '3333333333333333333333333333333333333333',
  report: 'Reviewed.',
  commits: 1,
  deferred: [{ title: 'Follow up', body: 'Evidence.' }],
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
  const approvedHead = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  writeFileSync(join(root, 'file.txt'), 'changed\n');
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
    'change',
  ]);
  const publishedHead = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  execFileSync('git', ['-C', root, 'branch', '-M', 'sealed']);
  const sealedPlan = {
    ...plan,
    approvedHead,
    publishedHead,
    baseSha: approvedHead,
  };
  sealReviewPlan(root, sealedPlan);
  expect(readSealedReviewPlan(root, 'sealed')).toEqual(sealedPlan);
  const sealedHead = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
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
    '--allow-empty',
    '-qC',
    sealedHead,
  ]);
  expect(readSealedReviewPlan(root, 'sealed')).toBeNull();
});

it('refuses to seal staged, unstaged, or outcome-file changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'poller-review-dirty-'));
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
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const cleanPlan = {
    ...plan,
    approvedHead: head,
    publishedHead: head,
    baseSha: head,
    commits: 0,
  };
  writeFileSync(join(root, 'untracked.txt'), 'dirty\n');
  expect(() => sealReviewPlan(root, cleanPlan)).toThrow('dirty');
  rmSync(join(root, 'untracked.txt'));
  writeFileSync(join(root, 'file.txt'), 'unstaged\n');
  expect(() => sealReviewPlan(root, cleanPlan)).toThrow('dirty');
  execFileSync('git', ['-C', root, 'reset', '--hard', '-q']);
  mkdirSync(join(root, '.standards-poller'));
  writeFileSync(join(root, '.standards-poller', 'outcome.json'), '{}');
  execFileSync('git', ['-C', root, 'add', '.standards-poller/outcome.json']);
  expect(() => sealReviewPlan(root, cleanPlan)).toThrow('dirty');
});

it('rejects malformed markers', () => {
  expect(parseReviewPlan('no marker')).toBeNull();
  expect(
    parseReviewPlan('<!-- standards-poller:review-output\nbm90LWpzb24\n-->'),
  ).toBeNull();
});
