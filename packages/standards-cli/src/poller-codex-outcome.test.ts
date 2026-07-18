import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFixOutcome, readReviewOutcome } from './poller-outcome';
import { OUTCOME_DIR, OUTCOME_FILE } from './poller-protocol';

const dirs: Array<string> = [];

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
    );
    expect(outcome?.status).toBe('fixed');
  });

  it('rejects a fixed outcome with a malformed PR title', async () => {
    const outcome = await readFixOutcome(
      workDirWithOutcome({
        status: 'fixed',
        summary: 'done',
        prTitle: 'Fixed the thing',
        prBody: 'Fixes #7',
      }),
    );
    expect(outcome).toBeNull();
  });

  it('rejects a question outcome without a question', async () => {
    const outcome = await readFixOutcome(
      workDirWithOutcome({ status: 'question', summary: 'blocked' }),
    );
    expect(outcome).toBeNull();
  });

  it('rejects unknown statuses, malformed JSON, and a missing file', async () => {
    expect(
      await readFixOutcome(
        workDirWithOutcome({ status: 'done', summary: 'x' }),
      ),
    ).toBeNull();
    expect(await readFixOutcome(workDirWithOutcome('not json'))).toBeNull();
    const empty = mkdtempSync(join(tmpdir(), 'poller-outcome-'));
    dirs.push(empty);
    expect(await readFixOutcome(empty)).toBeNull();
  });
});

describe('readReviewOutcome', () => {
  it('accepts a reviewed outcome with deferred findings', async () => {
    const outcome = await readReviewOutcome(
      workDirWithOutcome({
        status: 'reviewed',
        summary: 'Two fixes, one deferral.',
        report: '## Review\n...',
        deferred: [{ title: 'fix(x): tighten y', body: 'Evidence: ...' }],
      }),
    );
    expect(outcome?.deferred).toHaveLength(1);
  });

  it('rejects a reviewed outcome without a report', async () => {
    expect(
      await readReviewOutcome(
        workDirWithOutcome({ status: 'reviewed', summary: 'done' }),
      ),
    ).toBeNull();
  });

  it('rejects malformed deferred entries', async () => {
    expect(
      await readReviewOutcome(
        workDirWithOutcome({
          status: 'reviewed',
          summary: 'done',
          report: 'r',
          deferred: [{ title: 'only-a-title' }],
        }),
      ),
    ).toBeNull();
  });
});
