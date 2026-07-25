import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFixOutcome, readReviewOutcome } from './poller-outcome';
import { OUTCOME_DIR, OUTCOME_FILE } from './poller-protocol';

const dirs: Array<string> = [];
const ISSUE_NUMBER = 7;

const workDirWithOutcome = (outcome: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'poller-outcome-'));
  dirs.push(dir);
  mkdirSync(join(dir, OUTCOME_DIR), { recursive: true });
  writeFileSync(
    join(dir, OUTCOME_FILE),
    typeof outcome === 'string' ? outcome : JSON.stringify(outcome),
  );
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('readFixOutcome', () => {
  it('accepts a fixed outcome with a conventional PR title', async () => {
    const outcome = await readFixOutcome(
      workDirWithOutcome({
        status: 'fixed',
        summary: 'Corrected the boundary check.',
        prTitle: 'fix(auth): reject expired session tokens',
        prBody: 'Handles expiry.\n\nFixes #7',
      }),
      ISSUE_NUMBER,
    );
    expect(outcome?.status).toBe('fixed');
  });

  it('accepts any supported closing keyword for the exact issue', async () => {
    const outcome = await readFixOutcome(
      workDirWithOutcome({
        status: 'fixed',
        summary: 'Corrected the boundary check.',
        prTitle: 'fix(auth): reject expired session tokens',
        prBody: 'Handles expiry.\n\nRESOLVES: #7',
      }),
      ISSUE_NUMBER,
    );
    expect(outcome?.status).toBe('fixed');
  });

  it.each([
    ['missing reference', 'Handles expiry.'],
    ['wrong issue', 'Handles expiry.\n\nFixes #8'],
    ['an issue-number prefix', 'Handles expiry.\n\nFixes #70'],
    ['non-closing reference', 'Handles expiry; see #7.'],
    ['inline-code reference', 'Use a footer like `Fixes #7`.'],
    ['fenced-code reference', 'Example:\n\n```markdown\nFixes #7\n```'],
    ['HTML-comment reference', '<!-- Fixes #7 -->'],
  ])('rejects a fixed outcome with %s', async (_name, prBody) => {
    const outcome = await readFixOutcome(
      workDirWithOutcome({
        status: 'fixed',
        summary: 'Corrected the boundary check.',
        prTitle: 'fix(auth): reject expired session tokens',
        prBody,
      }),
      ISSUE_NUMBER,
    );
    expect(outcome).toBeNull();
  });

  it('rejects a fixed outcome with a malformed PR title', async () => {
    const outcome = await readFixOutcome(
      workDirWithOutcome({
        status: 'fixed',
        summary: 'done',
        prTitle: 'Fixed the thing',
        prBody: 'Fixes #7',
      }),
      ISSUE_NUMBER,
    );
    expect(outcome).toBeNull();
  });

  it('rejects a question outcome without a question', async () => {
    const outcome = await readFixOutcome(
      workDirWithOutcome({ status: 'question', summary: 'blocked' }),
      ISSUE_NUMBER,
    );
    expect(outcome).toBeNull();
  });

  it('rejects unknown statuses, malformed JSON, and a missing file', async () => {
    expect(
      await readFixOutcome(
        workDirWithOutcome({ status: 'done', summary: 'x' }),
        ISSUE_NUMBER,
      ),
    ).toBeNull();
    expect(
      await readFixOutcome(workDirWithOutcome('not json'), ISSUE_NUMBER),
    ).toBeNull();
    const empty = mkdtempSync(join(tmpdir(), 'poller-outcome-'));
    dirs.push(empty);
    expect(await readFixOutcome(empty, ISSUE_NUMBER)).toBeNull();
  });
});

describe('readReviewOutcome', () => {
  it('accepts a reviewed outcome with its report', async () => {
    const outcome = await readReviewOutcome(
      workDirWithOutcome({
        status: 'reviewed',
        summary: 'Two fixes.',
        report: '## Review\n...',
        threadsToResolve: [
          {
            threadId: 'PRRT_thread',
            verificationReply: 'Fixed in abc123; focused tests pass.',
          },
        ],
      }),
    );
    expect(outcome).toEqual({
      status: 'reviewed',
      summary: 'Two fixes.',
      report: '## Review\n...',
      threadsToResolve: [
        {
          threadId: 'PRRT_thread',
          verificationReply: 'Fixed in abc123; focused tests pass.',
        },
      ],
    });
  });

  it('rejects reviewed outcomes without the exact thread-resolution shape', async () => {
    expect(
      await readReviewOutcome(
        workDirWithOutcome({
          status: 'reviewed',
          summary: 'done',
          report: 'Report',
        }),
      ),
    ).toBeNull();
    expect(
      await readReviewOutcome(
        workDirWithOutcome({
          status: 'reviewed',
          summary: 'done',
          report: 'Report',
          threadsToResolve: [
            {
              threadId: 'PRRT_thread',
              verificationReply: 'Evidence',
              extra: true,
            },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      await readReviewOutcome(
        workDirWithOutcome({
          status: 'reviewed',
          summary: 'done',
          report: 'Report',
          threadsToResolve: [],
          deferred: [],
        }),
      ),
    ).toBeNull();
  });
});
