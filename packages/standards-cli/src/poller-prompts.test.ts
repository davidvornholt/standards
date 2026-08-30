import { describe, expect, it } from 'bun:test';
import { fixPrompt, reviewPrompt } from './poller-prompts';

describe('poller GitHub access contract', () => {
  it('lets a review run apply an authorized PR body update without another question', () => {
    const prompt = reviewPrompt({
      repo: 'owner/repo',
      prNumber: 143,
      title: 'fix(cli): reject null settings',
      baseSha: 'base-sha',
      headSha: 'approved-head',
      approvalId: 'approval-generation',
      answers: ['The PR body can be updated.'],
    });

    expect(prompt).toContain(
      'Authenticated GitHub access is available through `gh`.',
    );
    expect(prompt).toContain("update this PR's title or body");
    expect(prompt).toContain(
      'Approval generation approval-generation authorizes writes only to owner/repo PR #143',
    );
    expect(prompt).toContain(
      "Immediately before EVERY GitHub write, re-read the PR's draft state, head SHA, and approval label",
    );
    expect(prompt).toContain('exact head approved-head');
    expect(prompt).toContain('label `approved-for-review`');
    expect(prompt).toContain(
      'Every comment, review thread, and deferred issue create must carry a stable hidden marker',
    );
    expect(prompt).toContain(
      '<!-- standards-poller:review-thread approval=approval-generation operation=<sha256> -->',
    );
    expect(prompt).toContain(
      'Deferred issue markers must additionally bind the stable review-ledger finding identity',
    );
    expect(prompt).toContain(
      'Search the complete target for that marker before creating',
    );
    expect(prompt).toContain('You may post block review threads');
    expect(prompt).toContain('do not reply to or resolve them');
    expect(prompt).toContain('"threadsToResolve"');
    expect(prompt).toContain(
      '<answer>\nThe PR body can be updated.\n</answer>',
    );
    expect(prompt).toContain('Keep the PR draft');
    expect(prompt).not.toContain('There is no GitHub access.');
    expect(prompt).not.toContain('fix-now review threads');
  });

  it('keeps an approved fix issue immutable while allowing GitHub collaboration', () => {
    const prompt = fixPrompt({
      repo: 'owner/repo',
      issueNumber: 7,
      title: 'Fix the boundary',
      body: 'Observed behavior.',
      approvalId: 'fix-approval',
      answers: [],
    });

    expect(prompt).toContain(
      'Authenticated GitHub access is available through `gh`.',
    );
    expect(prompt).toContain(
      'Approval generation fix-approval authorizes work only on owner/repo issue #7 with the exact title "Fix the boundary", exact body "Observed behavior.", and label `approved-for-fix`.',
    );
    expect(prompt).toContain(
      'Immediately before EVERY GitHub write, re-read the issue and require that exact title, exact body, and approved label.',
    );
    expect(prompt).toContain(
      'Every create must carry a stable hidden marker binding approval generation fix-approval',
    );
  });

  it('hands only unavoidable decisions back to the poller without GitHub writes or waiting', () => {
    const prompt = reviewPrompt({
      repo: 'owner/repo',
      prNumber: 143,
      title: 'fix(cli): reject null settings',
      baseSha: 'base-sha',
      headSha: 'approved-head',
      approvalId: 'approval-generation',
      answers: [],
    });

    expect(prompt).toContain(
      'Override every review-fix skill instruction to publish or wait on an ask decision',
    );
    expect(prompt).toContain('strict ask bar is met');
    expect(prompt).toContain('do not comment, label, wait, or poll GitHub');
    expect(prompt).toContain('Write status "question"');
    expect(prompt).toContain(
      'Do not hand reversible or inferable choices back to the maintainer.',
    );
  });
});
