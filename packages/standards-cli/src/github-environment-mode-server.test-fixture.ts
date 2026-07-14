import { HTTP_NO_CONTENT, HTTP_NOT_FOUND, HTTP_OK } from './github-api';

const HTTP_ERROR = 500;
const WAIT_TIMER = 'wait_timer';
const PREVENT_SELF_REVIEW = 'prevent_self_review';
const DEPLOYMENT_BRANCH_POLICY = 'deployment_branch_policy';
const DEPLOYMENT_BRANCH_POLICIES = 'deployment_branch_policies';
const PROTECTED_BRANCHES = 'protected_branches';
const CUSTOM_BRANCH_POLICIES = 'custom_branch_policies';
const TOTAL_COUNT = 'total_count';
const BRANCH_POLICIES = 'branch_policies';
const NODE_ID = 'node_id';
const CUSTOM_PROTECTION_RULES = 'custom_deployment_protection_rules';
const PROTECTION_RULES = 'protection_rules';

const response = (status: number, body: unknown = null): Response =>
  new Response(body === null ? null : JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });

export const declaration = (
  name: string,
  custom: boolean,
  policies: ReadonlyArray<string>,
): Readonly<Record<string, unknown>> => ({
  name,
  [WAIT_TIMER]: 0,
  [PREVENT_SELF_REVIEW]: false,
  reviewers: [],
  [DEPLOYMENT_BRANCH_POLICY]: {
    [PROTECTED_BRANCHES]: !custom,
    [CUSTOM_BRANCH_POLICIES]: custom,
  },
  [DEPLOYMENT_BRANCH_POLICIES]: policies.map((policy) => ({ name: policy })),
});

type ServerOptions = {
  readonly custom: boolean;
  readonly policies?: ReadonlyArray<string>;
  readonly putFails?: boolean;
  readonly restoreFails?: boolean;
  readonly waitTimer?: number;
};

type ServerState = {
  custom: boolean;
  readonly policies: Set<string>;
};

type RequestDetails = {
  readonly body: Readonly<Record<string, unknown>> | null;
  readonly method: string;
};

const branchResponse = (
  details: RequestDetails,
  state: ServerState,
  options: ServerOptions,
): Response => {
  const { body, method } = details;
  if (!state.custom) {
    return response(HTTP_NOT_FOUND);
  }
  if (method === 'GET') {
    return response(HTTP_OK, {
      [TOTAL_COUNT]: state.policies.size,
      [BRANCH_POLICIES]: [...state.policies].map((policy, index) => ({
        id: index + 1,
        [NODE_ID]: `node-${index + 1}`,
        name: policy,
      })),
    });
  }
  if (method === 'DELETE') {
    state.policies.delete([...state.policies][0] ?? '');
    return response(HTTP_NO_CONTENT);
  }
  if (options.restoreFails && options.putFails) {
    return response(HTTP_ERROR, { message: 'restore failed' });
  }
  state.policies.add(String(body?.name));
  return response(HTTP_OK, {});
};

const protectionResponse = (
  body: Readonly<Record<string, unknown>> | null,
  state: ServerState,
  options: ServerOptions,
): Response => {
  if (options.putFails) {
    return response(HTTP_ERROR, { message: 'protection failed' });
  }
  const policy = body?.[DEPLOYMENT_BRANCH_POLICY];
  state.custom =
    typeof policy === 'object' &&
    policy !== null &&
    CUSTOM_BRANCH_POLICIES in policy &&
    policy[CUSTOM_BRANCH_POLICIES] === true;
  return response(HTTP_OK, {});
};

const environmentResponse = (
  name: string,
  state: ServerState,
  waitTimer: number | undefined,
): Response =>
  response(HTTP_OK, {
    name,
    [PROTECTION_RULES]:
      waitTimer === undefined
        ? []
        : [{ type: WAIT_TIMER, [WAIT_TIMER]: waitTimer }],
    [DEPLOYMENT_BRANCH_POLICY]: {
      [PROTECTED_BRANCHES]: !state.custom,
      [CUSTOM_BRANCH_POLICIES]: state.custom,
    },
  });

export const installStatefulServer = (
  originalFetch: typeof globalThis.fetch,
  name: string,
  options: ServerOptions,
) => {
  const calls: Array<string> = [];
  const bodies: Array<unknown> = [];
  const { custom, policies: initialPolicies = [], waitTimer } = options;
  const state = { custom, policies: new Set(initialPolicies) };
  globalThis.fetch = Object.assign(
    (input: URL | RequestInfo, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      const { pathname } = new URL(url);
      calls.push(`${method} ${url}`);
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null;
      if (body !== null) {
        bodies.push(body);
      }
      let result: Response;
      if (pathname.endsWith('/deployment_protection_rules')) {
        result = response(HTTP_OK, {
          [TOTAL_COUNT]: 0,
          [CUSTOM_PROTECTION_RULES]: [],
        });
      } else if (pathname.includes('/deployment-branch-policies')) {
        result = branchResponse({ body, method }, state, options);
      } else if (method === 'PUT') {
        result = protectionResponse(body, state, options);
      } else {
        result = environmentResponse(name, state, waitTimer);
      }
      return Promise.resolve(result);
    },
    { preconnect: originalFetch.preconnect },
  );
  return { bodies, calls, policies: state.policies };
};
