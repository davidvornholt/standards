// The Actions event policy that Standards auto-merge needs in a public
// repository. GitHub blocks `pull_request_target` there unless an active
// policy allows it for the workflow, so without one Dependabot and sync pull
// requests stop merging on their own. The policy isn't declared in
// settings.json because every consumer needs the same one, for the synced
// workflow path.
//
// Reading policies needs repository Administration write, which no workflow
// token can hold, so a check whose token can't read them prints a notice and
// leaves the verification to a local, admin-authenticated check.

import { matchesGlob } from 'node:path';
import {
  type ApiResponse,
  apiError,
  HTTP_CREATED,
  HTTP_FORBIDDEN,
  HTTP_OK,
  HTTP_UNAUTHORIZED,
  request,
} from './github-api';
import { isRecord } from './github-settings-parse';

const HTTP_NOT_FOUND = 404;
const PAGE_SIZE = 100;
const API_ROOT = 'https://api.github.com';
const ALL_WORKFLOWS = '~ALL';

export const AUTO_MERGE_WORKFLOW_PATH =
  '.github/workflows/standards-auto-merge.yml';

// Every event the workflow triggers on: a policy that matches the workflow
// allows only the events it lists.
const REQUIRED_EVENTS: ReadonlyArray<string> = ['pull_request_target', 'push'];

export const AUTO_MERGE_POLICY = {
  name: 'Standards auto-merge events',
  enforcement: 'active',
  conditions: {
    // biome-ignore lint/style/useNamingConvention: GitHub's REST field.
    workflow_path: { include: [AUTO_MERGE_WORKFLOW_PATH], exclude: [] },
  },
  rules: [
    {
      type: 'restrict_action_events',
      // biome-ignore lint/style/useNamingConvention: GitHub's REST field.
      parameters: { allowed_events: [...REQUIRED_EVENTS] },
    },
  ],
} as const;

export const POLICY_NOT_VISIBLE_NOTICE = `standards github: Actions event policies not verified, because this token can't read them; they need repository Administration write, which no workflow token holds. Run \`bun standards github --check\` locally with admin auth to verify that public repositories allow pull_request_target for ${AUTO_MERGE_WORKFLOW_PATH}`;

type Policy = Readonly<Record<string, unknown>>;

export type LivePolicies =
  | { readonly kind: 'visible'; readonly policies: ReadonlyArray<Policy> }
  | { readonly kind: 'not-visible' };

const stringList = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

const patternMatches = (pattern: string): boolean =>
  pattern === ALL_WORKFLOWS ||
  pattern === AUTO_MERGE_WORKFLOW_PATH ||
  matchesGlob(AUTO_MERGE_WORKFLOW_PATH, pattern);

// A policy without a workflow_path condition, or with an empty include list,
// targets every workflow that its exclude list doesn't name.
const matchesWorkflow = (policy: Policy): boolean => {
  const conditions = isRecord(policy.conditions) ? policy.conditions : {};
  if (!isRecord(conditions.workflow_path)) {
    return true;
  }
  const include = stringList(conditions.workflow_path.include);
  const exclude = stringList(conditions.workflow_path.exclude);
  return (
    (include.length === 0 || include.some(patternMatches)) &&
    !exclude.some(patternMatches)
  );
};

// The events a policy lets matching workflows run on, or null when the policy
// has no event rule and so doesn't restrict or allow events.
const allowedEvents = (policy: Policy): ReadonlySet<string> | null => {
  const rules = Array.isArray(policy.rules)
    ? policy.rules.filter(isRecord)
    : [];
  const eventRules = rules.filter(
    (rule) => rule.type === 'restrict_action_events',
  );
  if (eventRules.length === 0) {
    return null;
  }
  return new Set(
    eventRules.flatMap((rule) =>
      isRecord(rule.parameters)
        ? stringList(rule.parameters.allowed_events)
        : [],
    ),
  );
};

const policyLabel = (policy: Policy): string =>
  `Actions policy "${String(policy.name)}"${
    policy.source_type === 'Repository' || policy.source === undefined
      ? ''
      : ` from ${String(policy.source)}`
  }`;

export const diffActionsPolicies = (
  policies: ReadonlyArray<Policy>,
): ReadonlyArray<string> => {
  const applicable = policies
    .filter((policy) => policy.enforcement === 'active')
    .filter(matchesWorkflow)
    .flatMap((policy) => {
      const events = allowedEvents(policy);
      return events === null ? [] : [{ policy, events }];
    });
  const problems = applicable.flatMap(({ policy, events }) => {
    const missing = REQUIRED_EVENTS.filter((event) => !events.has(event));
    return missing.length === 0
      ? []
      : [
          `${policyLabel(policy)} applies to ${AUTO_MERGE_WORKFLOW_PATH} but doesn't allow ${missing.join(', ')}, so Standards auto-merge can't run on those events`,
        ];
  });
  if (applicable.length === 0) {
    return [
      `no active Actions event policy allows ${REQUIRED_EVENTS.join(' and ')} for ${AUTO_MERGE_WORKFLOW_PATH}; GitHub blocks pull_request_target in public repositories without one, so bot pull requests stop merging on their own`,
    ];
  }
  return problems;
};

const isDenied = (response: ApiResponse): boolean =>
  [HTTP_UNAUTHORIZED, HTTP_FORBIDDEN, HTTP_NOT_FOUND].includes(response.status);

// The list omits conditions and rules, so each policy is read through its own
// link, which also reaches policies an organization or enterprise sets.
const readPolicy = async (
  token: string | null,
  summary: Policy,
): Promise<Policy> => {
  const links = isRecord(summary._links) ? summary._links : {};
  const href =
    isRecord(links.self) && typeof links.self.href === 'string'
      ? links.self.href
      : '';
  if (!href.startsWith(`${API_ROOT}/`)) {
    throw new Error(
      `${policyLabel(summary)} has no API link to read its conditions and rules`,
    );
  }
  const response = await request(token, 'GET', href.slice(API_ROOT.length));
  if (response.status !== HTTP_OK || !isRecord(response.body)) {
    throw new Error(apiError(`reading ${policyLabel(summary)}`, response));
  }
  return { ...summary, ...response.body };
};

export const fetchActionsPolicies = async (
  token: string | null,
  repo: string,
): Promise<LivePolicies> => {
  const response = await request(
    token,
    'GET',
    `/repos/${repo}/actions/policies?per_page=${PAGE_SIZE}`,
  );
  if (isDenied(response)) {
    return { kind: 'not-visible' };
  }
  const body = isRecord(response.body) ? response.body : null;
  if (
    response.status !== HTTP_OK ||
    body === null ||
    !Array.isArray(body.policies)
  ) {
    throw new Error(apiError('listing Actions policies', response));
  }
  const summaries = body.policies.filter(isRecord);
  if (
    typeof body.total_count === 'number' &&
    body.total_count > summaries.length
  ) {
    throw new Error(
      `listing Actions policies: more than ${PAGE_SIZE} policies; refusing to judge from a truncated list`,
    );
  }
  return {
    kind: 'visible',
    policies: await Promise.all(
      summaries.map((summary) => readPolicy(token, summary)),
    ),
  };
};

export const isPublicRepository = (
  liveRepository: Readonly<Record<string, unknown>>,
): boolean => liveRepository.private === false;

// Creates the standard policy, or rewrites a repository policy of the same
// name, when no active policy already allows the workflow's events. A
// conflicting policy from elsewhere is reported, never changed.
export const applyActionsPolicy = async (
  token: string,
  repo: string,
): Promise<ReadonlyArray<string>> => {
  const live = await fetchActionsPolicies(token, repo);
  if (live.kind === 'not-visible') {
    throw new Error(
      'cannot read Actions policies; apply needs a token with repository Administration write',
    );
  }
  if (diffActionsPolicies(live.policies).length === 0) {
    return [];
  }
  const own = live.policies.find(
    (policy) =>
      policy.name === AUTO_MERGE_POLICY.name &&
      policy.source_type === 'Repository',
  );
  const response =
    own === undefined
      ? await request(
          token,
          'POST',
          `/repos/${repo}/actions/policies`,
          AUTO_MERGE_POLICY,
        )
      : await request(
          token,
          'PUT',
          `/repos/${repo}/actions/policies/${String(own.id)}`,
          AUTO_MERGE_POLICY,
        );
  const [verb, done, expected] =
    own === undefined
      ? ['creating', 'created', HTTP_CREATED]
      : ['updating', 'updated', HTTP_OK];
  const action = `${done} Actions policy "${AUTO_MERGE_POLICY.name}"`;
  if (response.status !== expected) {
    throw new Error(
      apiError(`${verb} Actions policy "${AUTO_MERGE_POLICY.name}"`, response),
    );
  }
  const remaining = diffActionsPolicies([
    ...live.policies.filter((policy) => policy !== own),
    AUTO_MERGE_POLICY,
  ]);
  if (remaining.length > 0) {
    throw new Error(`${action}, but ${remaining.join('; ')}`);
  }
  return [action];
};
