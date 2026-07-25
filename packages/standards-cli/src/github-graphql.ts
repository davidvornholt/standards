// GraphQL fallbacks for repository state REST hides from tokens that can
// legitimately read it. Each returns only what GraphQL actually answered, so a
// remaining gap stays unverifiable instead of becoming a false pass.

import { apiError, HTTP_OK, request } from './github-api';
import { isRecord } from './github-settings-parse';

// The `repository` node GraphQL answered with, or why there is no answer.
type GraphqlAnswer = {
  readonly repository: Readonly<Record<string, unknown>> | null;
  readonly failure: string | null;
};

const errorSummary = (errors: ReadonlyArray<unknown>): string =>
  errors
    .map((error) =>
      isRecord(error) && typeof error.message === 'string'
        ? error.message
        : JSON.stringify(error),
    )
    .join('; ');

// GraphQL reports a permission failure as HTTP 200 with a partial `data` and a
// non-empty `errors` array, so a body carrying errors is no answer at all: a
// suppressed field that survives as a plausible value — `0` for a count — must
// never be read as a verified one.
const queryRepository = async (
  token: string | null,
  repo: string,
  selection: string,
): Promise<GraphqlAnswer> => {
  const [owner, name] = repo.split('/');
  if (owner === undefined || name === undefined) {
    return {
      repository: null,
      failure: `"${repo}" is not an owner/name repository`,
    };
  }
  const response = await request(token, 'POST', '/graphql', {
    query: `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${selection} } }`,
  });
  if (response.status !== HTTP_OK || !isRecord(response.body)) {
    return {
      repository: null,
      failure: apiError('querying the GraphQL API', response),
    };
  }
  const errors = response.body.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return {
      repository: null,
      failure: `HTTP ${response.status} ${errorSummary(errors)}`,
    };
  }
  const data = isRecord(response.body.data) ? response.body.data : null;
  if (data === null || !isRecord(data.repository)) {
    return {
      repository: null,
      failure: `HTTP ${response.status} the response carried no repository`,
    };
  }
  return { repository: data.repository, failure: null };
};

const GRAPHQL_MERGE_FIELDS: ReadonlyMap<string, string> = new Map([
  ['allow_auto_merge', 'autoMergeAllowed'],
  ['allow_merge_commit', 'mergeCommitAllowed'],
  ['allow_rebase_merge', 'rebaseMergeAllowed'],
  ['allow_squash_merge', 'squashMergeAllowed'],
  ['delete_branch_on_merge', 'deleteBranchOnMerge'],
  ['merge_commit_message', 'mergeCommitMessage'],
  ['merge_commit_title', 'mergeCommitTitle'],
  ['squash_merge_commit_message', 'squashMergeCommitMessage'],
  ['squash_merge_commit_title', 'squashMergeCommitTitle'],
]);

// REST omits repository merge settings for read-only viewers (they surface
// only with write access — community discussion #153258), but GraphQL serves
// the same values, with identical enum spellings, to any token that can read
// the repository. This keeps a read-only token sufficient for the check.
// Returns only the keys GraphQL answered; the rest stay unverifiable.
export const fetchMergeSettingsViaGraphql = async (
  token: string | null,
  repo: string,
  keys: ReadonlyArray<string>,
): Promise<Readonly<Record<string, unknown>>> => {
  const mapped = keys.filter((key) => GRAPHQL_MERGE_FIELDS.has(key));
  if (mapped.length === 0) {
    return {};
  }
  const answer = await queryRepository(
    token,
    repo,
    mapped.map((key) => GRAPHQL_MERGE_FIELDS.get(key)).join(' '),
  );
  if (answer.repository === null) {
    return {};
  }
  const repository = answer.repository;
  return Object.fromEntries(
    mapped
      .map((key) => [key, repository[GRAPHQL_MERGE_FIELDS.get(key) ?? '']])
      .filter(([, value]) => value !== undefined && value !== null),
  );
};

// One page is every ruleset any consumer declares. Nothing rests on that:
// counts are only ever consulted for rulesets the REST loader listed, and a
// ruleset GraphQL did not answer for stays unverifiable.
const GRAPHQL_RULESET_PAGE = 100;

// Asking for one actor makes the count self-corroborating at no extra cost:
// `totalCount === 0` must yield an empty node list and `totalCount >= 1`
// exactly one node.
const BYPASS_ACTOR_PROBE = 1;

// A repository-owned ruleset node paired with its bypass-actor count, keyed by
// the id REST reports for the same ruleset, or null for anything else.
// Org-inherited rulesets are outside this declaration's authority, the same
// filter the REST loader applies. A node list that disagrees with its own
// `totalCount` means the connection is being filtered rather than merely
// redacted, so it supplies no count; a null *element* is the documented
// identity-withholding shape, so only the length is checked.
const countedRuleset = (node: unknown): readonly [number, number] | null => {
  if (!isRecord(node) || typeof node.databaseId !== 'number') {
    return null;
  }
  if (!isRecord(node.source) || node.source.__typename !== 'Repository') {
    return null;
  }
  const actors = isRecord(node.bypassActors) ? node.bypassActors : null;
  if (
    actors === null ||
    typeof actors.totalCount !== 'number' ||
    !Array.isArray(actors.nodes)
  ) {
    return null;
  }
  const total = actors.totalCount;
  return total >= 0 &&
    actors.nodes.length === Math.min(total, BYPASS_ACTOR_PROBE)
    ? [node.databaseId, total]
    : null;
};

// Nothing promises an id appears once in the node list, and a repeated key
// would silently take the last node's count. Dropping the id entirely degrades
// it to unverifiable instead.
const withoutRepeatedIds = (
  entries: ReadonlyArray<readonly [number, number]>,
): ReadonlyMap<number, number> => {
  const seen = new Set<number>();
  const repeated = new Set<number>();
  for (const [id] of entries) {
    if (seen.has(id)) {
      repeated.add(id);
    }
    seen.add(id);
  }
  return new Map(entries.filter(([id]) => !repeated.has(id)));
};

export type BypassActorCounts = {
  // Keyed by ruleset id, never by name: two live rulesets may share a name, and
  // joining on it would let a harmless ruleset's count verify a bypassed
  // ruleset's list.
  readonly counts: ReadonlyMap<number, number>;
  readonly failure: string | null;
};

// REST omits ruleset `bypass_actors` for viewers without repository
// Administration access, and omits it from GitHub App installation tokens
// whatever the App's permissions — so a brokered CI token can never read the
// list there. GraphQL answers `bypassActors` on the same repository-owned
// rulesets and serves an exact `totalCount` to those tokens, withholding only
// the actor identities. Returns the count per ruleset id; an id GraphQL did
// not answer for stays absent, so the caller keeps it unverifiable.
export const fetchBypassActorCountsViaGraphql = async (
  token: string | null,
  repo: string,
): Promise<BypassActorCounts> => {
  const answer = await queryRepository(
    token,
    repo,
    `rulesets(first: ${GRAPHQL_RULESET_PAGE}, includeParents: false) { nodes { databaseId source { __typename } bypassActors(first: ${BYPASS_ACTOR_PROBE}) { totalCount nodes { __typename } } } }`,
  );
  const rulesets =
    answer.repository !== null && isRecord(answer.repository.rulesets)
      ? answer.repository.rulesets
      : null;
  const nodes =
    rulesets !== null && Array.isArray(rulesets.nodes) ? rulesets.nodes : [];
  return {
    counts: withoutRepeatedIds(
      nodes.map(countedRuleset).filter((entry) => entry !== null),
    ),
    failure: answer.failure,
  };
};
