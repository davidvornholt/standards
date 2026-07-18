import { HTTP_CREATED, HTTP_OK } from './github-api';
import type { ApiCall } from './github-commands-test-support';

const REPO = 'owner/repo';
const ISSUE_NUMBER = 7;
const CLAIM_COMMENT_START = 500;

type PollerApiOptions = {
  readonly baseSha: string;
  readonly headSha: string;
  readonly isPullRequest: boolean;
};

type ApiState = PollerApiOptions & {
  readonly comments: Array<Record<string, unknown>>;
  readonly labels: Set<string>;
  draft: boolean;
  nextCommentId: number;
};

type TestRequest = {
  readonly body: Record<string, unknown> | null;
  readonly method: string;
  readonly path: string;
};

type TestResponse = {
  readonly body: unknown;
  readonly status?: number;
};

type Handler = (request: TestRequest, state: ApiState) => TestResponse | null;

const issueHandler: Handler = ({ method, path }, state) =>
  method === 'GET' && path.endsWith(`/issues/${ISSUE_NUMBER}`)
    ? {
        body: {
          number: ISSUE_NUMBER,
          title: 'Title',
          body: 'Body',
          labels: [...state.labels].map((name) => ({ name })),
          user: { login: 'reporter' },
          ...(state.isPullRequest
            ? Object.fromEntries([['pull_request', { url: 'x' }]])
            : {}),
        },
      }
    : null;

const timelineHandler: Handler = ({ path }, state) =>
  path.endsWith('/timeline')
    ? {
        body: [
          {
            id: 101,
            event: 'labeled',
            label: {
              name: state.isPullRequest
                ? 'approved-for-review'
                : 'approved-for-fix',
            },
            actor: { login: 'maintainer' },
            ...Object.fromEntries([['created_at', '2026-07-18T10:00:00Z']]),
          },
          {
            id: 202,
            event: 'labeled',
            label: {
              name: state.isPullRequest
                ? 'review-in-progress'
                : 'fix-in-progress',
            },
            actor: { login: 'poller' },
            ...Object.fromEntries([['created_at', '2026-07-18T11:00:00Z']]),
          },
        ],
      }
    : null;

const collaboratorHandler: Handler = ({ path }) =>
  path.includes('/collaborators/')
    ? { body: Object.fromEntries([['role_name', 'admin']]) }
    : null;

const commentsHandler: Handler = ({ body, method, path }, state) => {
  if (!path.endsWith('/comments')) {
    return null;
  }
  if (method === 'GET') {
    return { body: state.comments };
  }
  state.nextCommentId += 1;
  state.comments.push({
    id: state.nextCommentId,
    body: body?.body,
    user: { login: 'poller' },
    ...Object.fromEntries([['created_at', '2026-07-18T11:00:00Z']]),
  });
  return { status: HTTP_CREATED, body: { id: state.nextCommentId } };
};

const labelsHandler: Handler = ({ body, method, path }, state) => {
  if (path.endsWith('/labels') && method === 'POST') {
    for (const label of (body?.labels as ReadonlyArray<string>) ?? []) {
      state.labels.add(label);
    }
    return { body: {} };
  }
  if (path.includes('/labels/') && method === 'DELETE') {
    state.labels.delete(decodeURIComponent(path.split('/').at(-1) ?? ''));
    return { body: {} };
  }
  return null;
};

const pullHandler: Handler = ({ method, path }, state) => {
  if (path.endsWith(`/pulls/${ISSUE_NUMBER}`) && method === 'GET') {
    return {
      body: {
        ...Object.fromEntries([['node_id', 'PR_node']]),
        title: 'Title',
        body: 'Body',
        draft: state.draft,
        head: {
          ref: 'feature',
          sha: state.headSha,
          repo: Object.fromEntries([['full_name', REPO]]),
        },
        base: { ref: 'main', sha: state.baseSha },
      },
    };
  }
  if (path.endsWith('/pulls') && method === 'GET') {
    return { body: [] };
  }
  return path.endsWith('/pulls') && method === 'POST'
    ? { status: HTTP_CREATED, body: { number: 44 } }
    : null;
};

const reviewHandler: Handler = ({ method, path }) =>
  path.endsWith('/reviews') ? { body: method === 'GET' ? [] : {} } : null;

const graphqlHandler: Handler = ({ path }, state) => {
  if (path !== '/graphql') {
    return null;
  }
  state.draft = false;
  return { body: { data: {} } };
};

const HANDLERS: ReadonlyArray<Handler> = [
  issueHandler,
  timelineHandler,
  collaboratorHandler,
  commentsHandler,
  labelsHandler,
  pullHandler,
  reviewHandler,
  graphqlHandler,
];

export const installPollerApi = (
  options: PollerApiOptions,
): ReadonlyArray<ApiCall> => {
  const calls: Array<ApiCall> = [];
  const state: ApiState = {
    ...options,
    comments: [],
    draft: true,
    labels: new Set([
      options.isPullRequest ? 'approved-for-review' : 'approved-for-fix',
    ]),
    nextCommentId: CLAIM_COMMENT_START,
  };
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
    const request = { body, method, path };
    calls.push(request);
    const [response] = HANDLERS.flatMap(
      (handler) => handler(request, state) ?? [],
    );
    if (response === undefined) {
      return Promise.reject(
        new Error(`unexpected GitHub API request: ${method} ${path}`),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(response.body), {
        status: response.status ?? HTTP_OK,
      }),
    );
  }) as typeof fetch;
  return calls;
};
