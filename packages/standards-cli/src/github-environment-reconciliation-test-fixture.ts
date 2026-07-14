const PROTECTION_RULES = 'protection_rules';
const WAIT_TIMER = 'wait_timer';
const PREVENT_SELF_REVIEW = 'prevent_self_review';
const DEPLOYMENT_BRANCH_POLICY = 'deployment_branch_policy';
const PROTECTED_BRANCHES = 'protected_branches';
const CUSTOM_BRANCH_POLICIES = 'custom_branch_policies';
const TOTAL_COUNT = 'total_count';
const CUSTOM_PROTECTION_RULES = 'custom_deployment_protection_rules';
const DRIFTED_WAIT_TIMER = 5;

export const originalFetch = globalThis.fetch;
export const customPath = 'deployment_protection_rules';
export const HTTP_ERROR = 500;

export const response = (status: number, body: unknown = null): Response =>
  new Response(body === null ? null : JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });

export const environment = (
  usesCustomBranches: boolean,
  waitTimer = DRIFTED_WAIT_TIMER,
) => ({
  name: 'production',
  [PROTECTION_RULES]: [
    { id: 1, type: 'branch_policy' },
    { type: WAIT_TIMER, [WAIT_TIMER]: waitTimer },
  ],
  [DEPLOYMENT_BRANCH_POLICY]: {
    [PROTECTED_BRANCHES]: !usesCustomBranches,
    [CUSTOM_BRANCH_POLICIES]: usesCustomBranches,
  },
});

export const customRules = (present: boolean) => ({
  [TOTAL_COUNT]: present ? 1 : 0,
  [CUSTOM_PROTECTION_RULES]: present
    ? [
        {
          app: { id: 9, slug: 'external-gate' },
          enabled: true,
          id: 8,
        },
      ]
    : [],
});

export const declared = {
  name: 'production',
  [WAIT_TIMER]: 0,
  [PREVENT_SELF_REVIEW]: false,
  reviewers: [],
  [DEPLOYMENT_BRANCH_POLICY]: {
    [PROTECTED_BRANCHES]: true,
    [CUSTOM_BRANCH_POLICIES]: false,
  },
};

export const installFetch = (
  handler: (url: string, method: string) => Response,
  calls: Array<string>,
): void => {
  globalThis.fetch = Object.assign(
    (input: URL | RequestInfo, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push(`${method} ${url}`);
      return Promise.resolve(handler(url, method));
    },
    { preconnect: originalFetch.preconnect },
  );
};
