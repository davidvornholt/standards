import { afterEach, describe, expect, it } from 'bun:test';
import { HTTP_OK } from './github-api';
import { type ApiCall, installApi } from './github-commands-test-support';
import { createPullRequestReview, getPullRequest } from './poller-github-pulls';

const originalFetch = globalThis.fetch;
const PR_NUMBER = 4;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('poller pull request API', () => {
  it('reads the exact base snapshot and anchors a review to commit_id', async () => {
    const calls: ReadonlyArray<ApiCall> = installApi([
      {
        body: {
          ...Object.fromEntries([['node_id', 'PR_node']]),
          title: 'Title',
          body: 'Body',
          draft: true,
          head: {
            ref: 'feature',
            sha: 'head',
            repo: Object.fromEntries([['full_name', 'owner/repo']]),
          },
          base: { ref: 'main', sha: 'base' },
        },
      },
      { status: HTTP_OK, body: {} },
    ]);
    const pr = await getPullRequest('token', 'owner/repo', PR_NUMBER);
    expect(pr).toMatchObject({
      headSha: 'head',
      baseRef: 'main',
      baseSha: 'base',
      draft: true,
    });
    await createPullRequestReview({
      token: 'token',
      repo: 'owner/repo',
      prNumber: PR_NUMBER,
      body: 'report',
      commitId: 'head',
    });
    expect(calls[1]?.body).toEqual(
      Object.fromEntries([
        ['event', 'COMMENT'],
        ['body', 'report'],
        ['commit_id', 'head'],
      ]),
    );
  });
});
