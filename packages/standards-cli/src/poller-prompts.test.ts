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
      answers: ['The PR body can be updated.'],
    });

    expect(prompt).toContain(
      'Authenticated GitHub access is available through `gh`.',
    );
    expect(prompt).toContain("update this PR's title or body");
    expect(prompt).toContain(
      'Routine PR metadata edits that are already authorized by a trusted maintainer answer do not require another confirmation.',
    );
    expect(prompt).toContain('approved head approved-head');
    expect(prompt).toContain(
      '<answer>\nThe PR body can be updated.\n</answer>',
    );
    expect(prompt).toContain('Keep the PR draft');
    expect(prompt).not.toContain('There is no GitHub access.');
  });

  it('keeps an approved fix issue immutable while allowing GitHub collaboration', () => {
    const prompt = fixPrompt({
      repo: 'owner/repo',
      issueNumber: 7,
      title: 'Fix the boundary',
      body: 'Observed behavior.',
      answers: [],
    });

    expect(prompt).toContain(
      'Authenticated GitHub access is available through `gh`.',
    );
    expect(prompt).toContain(
      "do not change the approved issue's title, body, labels, or state",
    );
  });
});
