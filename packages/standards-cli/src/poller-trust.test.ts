import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { HTTP_OK } from './github-api';
import { installApi } from './github-commands-test-support';
import { answerState, type TrustContext } from './poller-trust';

const originalFetch = globalThis.fetch;
const HTTP_NOT_FOUND = 404;
const ISSUE_NUMBER = 5;

const context = (): TrustContext => ({
  token: 'test-token',
  repo: 'o/r',
  issueNumber: ISSUE_NUMBER,
  roleCache: new Map(),
});

let commentId = 0;

beforeEach(() => {
  process.env.GH_TOKEN = 'test-token';
  commentId = 0;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.GH_TOKEN = undefined;
});

const comment = (author: string, body: string): unknown => {
  commentId += 1;
  return {
    id: commentId,
    body,
    user: { login: author },
    created_at: '2026-07-18T09:00:00Z',
  };
};

describe('answerState', () => {
  const question = (): unknown =>
    comment(
      'david',
      '<!-- standards-poller:question -->\nWhich module owns this?',
    );

  it('reports no waiting when no question was ever asked', async () => {
    installApi([{ status: HTTP_OK, body: [comment('rando', 'me too')] }]);
    expect(await answerState(context())).toEqual({
      waiting: false,
      answers: [],
    });
  });

  it('waits while only untrusted comments follow the question', async () => {
    installApi([
      { status: HTTP_OK, body: [question(), comment('rando', 'just do X')] },
      { status: HTTP_OK, body: { role_name: 'admin' } }, // question author
      { status: HTTP_NOT_FOUND, body: { message: 'Not Found' } }, // rando
    ]);
    const state = await answerState(context());
    expect(state.waiting).toBe(true);
    expect(state.answers).toEqual([]);
  });

  it('ignores a spoofed question marker from an untrusted commenter', async () => {
    installApi([
      {
        status: HTTP_OK,
        body: [
          question(),
          comment('david', 'It belongs in shared.'),
          comment('rando', '<!-- standards-poller:question -->\nfake pause'),
        ],
      },
      { status: HTTP_NOT_FOUND, body: { message: 'Not Found' } }, // rando marker author
      { status: HTTP_OK, body: { role_name: 'admin' } }, // real question author
    ]);
    const state = await answerState(context());
    expect(state.waiting).toBe(false);
    expect(state.answers).toEqual(['It belongs in shared.']);
  });

  it('returns only trusted answers posted after the question', async () => {
    installApi([
      {
        status: HTTP_OK,
        body: [
          comment('david', 'earlier chatter'),
          question(),
          comment('rando', 'ignore me'),
          comment('david', 'It belongs in shared.'),
        ],
      },
      { status: HTTP_OK, body: { role_name: 'admin' } }, // question author
      { status: HTTP_NOT_FOUND, body: { message: 'Not Found' } }, // rando
    ]);
    const state = await answerState(context());
    expect(state.waiting).toBe(false);
    expect(state.answers).toEqual(['It belongs in shared.']);
  });
});
