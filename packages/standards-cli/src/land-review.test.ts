import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { cleanupTmpDirs } from './cli-test-support';
import {
  BASE_TIP,
  branchExists,
  calls,
  check,
  createLand,
  git,
  type Land,
  land,
  mergeCall,
  mergeCalls,
  NEW_HEAD,
  reviewReport,
} from './land-test-support';

const SHA_LENGTH = 40;
// A commit outside the base branch's history.
const FOREIGN_TIP = 'c'.repeat(SHA_LENGTH);

// Longer than the output spawnSync buffers by default.
const LONG_COMMENT = 2_000_000;

let fixture: Land;

beforeEach(() => {
  fixture = createLand(process.env);
  Object.assign(fixture.pr, { state: 'OPEN' });
});

afterEach(() => {
  cleanupTmpDirs();
});

const comments = (): Array<Array<string>> => calls(fixture, 'pr', 'comment');

const commentLookups = (): Array<Array<string>> =>
  calls(fixture, 'api').filter((call) => call[1]?.includes('/comments'));

// The polls of the pull request's checks while land waits.
const polls = (): Array<Array<string>> =>
  calls(fixture, 'pr', 'view').filter((call) =>
    call.some((arg) => arg.includes('statusCheckRollup')),
  );

const refusal = (head: string): string =>
  `standards land: No review-fix report covers head ${head.slice(0, 7)} of PR #123. ` +
  'If a reviewer could find a bug in it that someone would otherwise run into, run the review-fix skill. ' +
  'Otherwise pass --no-review "<why it needs none>".\n';

describe('standards land and review-fix reports', () => {
  it('lands a pull request whose head a report covers', () => {
    fixture.pr.comments = [
      'Looks fine.',
      reviewReport(String(fixture.pr.headRefOid)),
    ];
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(commentLookups()).toEqual([
      [
        'api',
        'repos/test/repo/issues/123/comments?per_page=100',
        '--paginate',
        '--jq',
        '.[] | .user.login as $author | .body | split("\\n")[] | select(contains("Reviewed through ")) | {author: $author, line: .}',
      ],
    ]);
    expect(comments()).toEqual([]);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
  });

  it('finds a report among comments longer than a command may print', () => {
    fixture.pr.comments = [
      'x'.repeat(LONG_COMMENT),
      `Notes\r\n${reviewReport(String(fixture.pr.headRefOid))}\r\n`,
      `See Reviewed through ${NEW_HEAD}.`,
    ];
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(comments()).toEqual([]);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
  });

  it('counts only reports by the owner or the account running land', () => {
    const head = String(fixture.pr.headRefOid);
    fixture.pr.comments = [
      { author: 'stranger', body: reviewReport(head) },
      { author: 'TEST', body: reviewReport(NEW_HEAD) },
    ];
    const refused = land(fixture, ['123']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toBe(refusal(head));
    expect(mergeCalls(fixture)).toEqual([]);

    fixture.pr.comments.push({ author: 'Runner', body: reviewReport(head) });
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(calls(fixture, 'api', 'user')).toHaveLength(2);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
  });

  it('refuses when the only report covers an older head', () => {
    fixture.pr.comments = [reviewReport(NEW_HEAD)];
    const result = land(fixture, ['123']);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal(String(fixture.pr.headRefOid)));
    expect(mergeCalls(fixture)).toEqual([]);
    expect(branchExists(fixture)).toBe(true);
  });

  it('refuses without a report or --no-review, before it waits', () => {
    Object.assign(fixture.pr, {
      comments: ['Reviewed through the weekend.'],
      isDraft: true,
      mergeStateStatus: 'DRAFT',
    });
    const result = land(fixture, ['123']);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal(String(fixture.pr.headRefOid)));
    expect(calls(fixture, 'pr', 'ready')).toEqual([]);
    expect(polls()).toEqual([]);
    expect(mergeCalls(fixture)).toEqual([]);
  });

  it('only cleans up a merged pull request, without looking for a report', () => {
    Object.assign(fixture.pr, { state: 'MERGED', comments: [] });
    git(fixture, ['switch', 'feature/topic']);
    const result = land(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(commentLookups()).toEqual([]);
    expect(comments()).toEqual([]);
    expect(mergeCalls(fixture)).toEqual([]);
    expect(branchExists(fixture)).toBe(false);
  });
});

describe('standards land with --no-review', () => {
  it('posts the reason given with --no-review, then lands', () => {
    fixture.pr.comments = [];
    const result = land(fixture, ['123', '--no-review', ' standards sync ']);
    expect(result.status, result.stderr).toBe(0);
    expect(comments()).toEqual([
      [
        'pr',
        'comment',
        '123',
        '--repo',
        'https://github.com/test/repo',
        '--body',
        'Landing without review-fix: standards sync',
      ],
    ]);
    const order = calls(fixture, 'pr').map((call) => call[1]);
    expect(order.indexOf('comment')).toBeLessThan(order.indexOf('merge'));
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
  });

  it('posts nothing with --no-review when a report covers the head', () => {
    const result = land(fixture, ['--no-review', 'typo', '123']);
    expect(result.status, result.stderr).toBe(0);
    expect(comments()).toEqual([]);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
  });

  it.each([
    [['123', '--no-review', '']],
    [['123', '--no-review', '  ']],
    [['123', '--no-review']],
    [['123', '--no-review', '--no-wait']],
  ])('refuses --no-review without a reason: %j', (args) => {
    const result = land(fixture, args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--no-review needs a reason');
    expect(calls(fixture)).toEqual([]);
  });

  it('posts nothing with --no-review when the checks fail', () => {
    Object.assign(fixture.pr, {
      comments: [],
      statusCheckRollup: [check({ conclusion: 'FAILURE' })],
    });
    const result = land(fixture, ['123', '--no-review', 'typo']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('check failed');
    expect(comments()).toEqual([]);
    expect(mergeCalls(fixture)).toEqual([]);
  });
});

describe('standards land when the head changes while it waits', () => {
  const pushedHead = (): void => {
    fixture.pr.polls = [{ headRefOid: NEW_HEAD }];
  };

  // land's update of a branch that lacks its base moves the head to NEW_HEAD.
  const updatedHead = (parents: Array<string> | null): void => {
    fixture.github.behindBy = [1, 0];
    fixture.pr.polls = [{}, { headRefOid: NEW_HEAD }];
    if (parents !== null) {
      fixture.github.parents = { [NEW_HEAD]: parents };
    }
  };

  it('refuses a pushed head that no report covers', () => {
    pushedHead();
    const result = land(fixture, ['123']);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal(NEW_HEAD));
    expect(comments()).toEqual([]);
    expect(mergeCalls(fixture)).toEqual([]);
  });

  it('lands a pushed head that a report covers', () => {
    pushedHead();
    fixture.pr.comments.push(reviewReport(NEW_HEAD));
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(comments()).toEqual([]);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture, NEW_HEAD)]);
  });

  it('posts the reason given with --no-review for a pushed head, then lands', () => {
    pushedHead();
    const result = land(fixture, ['123', '--no-review', 'typo']);
    expect(result.status, result.stderr).toBe(0);
    expect(comments().map((call) => call.at(-1))).toEqual([
      'Landing without review-fix: typo',
    ]);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture, NEW_HEAD)]);
  });

  it('lands the merge commit of its own update on the reviewed head', () => {
    updatedHead([String(fixture.pr.headRefOid), BASE_TIP]);
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(calls(fixture, 'pr', 'update-branch')).toHaveLength(1);
    expect(comments()).toEqual([]);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture, NEW_HEAD)]);
  });

  it('refuses a merge on the reviewed head of a commit the base lacks', () => {
    // Like a push that replaces land's own merge commit with another one.
    updatedHead([String(fixture.pr.headRefOid), FOREIGN_TIP]);
    const result = land(fixture, ['123']);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal(NEW_HEAD));
    expect(mergeCalls(fixture)).toEqual([]);
  });

  it.each([
    ['a commit on top of the reviewed head', null],
    ['a merge commit on another commit', [BASE_TIP, BASE_TIP]],
  ])('refuses %s after its own update', (_case, parents) => {
    updatedHead(parents);
    const result = land(fixture, ['123']);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal(NEW_HEAD));
    expect(mergeCalls(fixture)).toEqual([]);
  });
});
