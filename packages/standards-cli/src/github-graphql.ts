// GraphQL fallbacks for repository state REST hides from tokens that can
// legitimately read it. Each returns only what GraphQL actually answered, so a
// remaining gap stays unverifiable instead of becoming a false pass.

import { HTTP_OK, request } from './github-api';
import { isRecord } from './github-settings-parse';

// The `repository` node of a GraphQL response, or null when the request
// failed, the token could not see the repository, or the body was not the
// shape GitHub documents.
const queryRepository = async (
  token: string | null,
  repo: string,
  selection: string,
): Promise<Readonly<Record<string, unknown>> | null> => {
  const [owner, name] = repo.split('/');
  if (owner === undefined || name === undefined) {
    return null;
  }
  const response = await request(token, 'POST', '/graphql', {
    query: `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${selection} } }`,
  });
  if (response.status !== HTTP_OK || !isRecord(response.body)) {
    return null;
  }
  const data = isRecord(response.body.data) ? response.body.data : null;
  return data !== null && isRecord(data.repository) ? data.repository : null;
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
  const repository = await queryRepository(
    token,
    repo,
    mapped.map((key) => GRAPHQL_MERGE_FIELDS.get(key)).join(' '),
  );
  if (repository === null) {
    return {};
  }
  return Object.fromEntries(
    mapped
      .map((key) => [key, repository[GRAPHQL_MERGE_FIELDS.get(key) ?? '']])
      .filter(([, value]) => value !== undefined && value !== null),
  );
};

// One page is every ruleset any consumer declares; a repository past it simply
// leaves the extra names uncounted, and the caller keeps them unverifiable.
const GRAPHQL_RULESET_PAGE = 100;

// A repository-owned ruleset node paired with its bypass-actor count, or null
// for anything else — org-inherited rulesets are outside this declaration's
// authority, the same filter the REST loader applies.
const countedRuleset = (node: unknown): readonly [string, number] | null => {
  if (!isRecord(node) || typeof node.name !== 'string') {
    return null;
  }
  const total = isRecord(node.bypassActors)
    ? node.bypassActors.totalCount
    : null;
  const repositoryOwned =
    isRecord(node.source) && node.source.__typename === 'Repository';
  return typeof total === 'number' && repositoryOwned
    ? [node.name, total]
    : null;
};

// REST omits ruleset `bypass_actors` for viewers without repository
// Administration access, and omits it from GitHub App installation tokens
// whatever the App's permissions — so a brokered CI token can never read the
// list there. GraphQL answers `bypassActors` on the same repository-owned
// rulesets and serves an exact `totalCount` to those tokens, withholding only
// the actor identities. Returns the count per ruleset name; a name GraphQL did
// not answer for stays absent, so the caller keeps it unverifiable.
export const fetchBypassActorCountsViaGraphql = async (
  token: string | null,
  repo: string,
): Promise<ReadonlyMap<string, number>> => {
  const repository = await queryRepository(
    token,
    repo,
    `rulesets(first: ${GRAPHQL_RULESET_PAGE}, includeParents: false) { nodes { name source { __typename } bypassActors(first: 1) { totalCount } } }`,
  );
  const rulesets =
    repository !== null && isRecord(repository.rulesets)
      ? repository.rulesets
      : null;
  const nodes =
    rulesets !== null && Array.isArray(rulesets.nodes) ? rulesets.nodes : [];
  return new Map(nodes.map(countedRuleset).filter((entry) => entry !== null));
};
