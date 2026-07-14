import { apiError, HTTP_OK, request } from './github-api';
import { isRecord } from './github-settings';

export type LiveRulesets = {
  readonly problem: string | null;
  readonly rulesets: ReadonlyArray<Record<string, unknown>> | null;
};

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

const validIdentity = (
  value: unknown,
  repo: string,
): value is Record<string, unknown> =>
  isRecord(value) &&
  Number.isSafeInteger(value.id) &&
  Number(value.id) > 0 &&
  typeof value.name === 'string' &&
  value.name.length > 0 &&
  value.source_type === 'Repository' &&
  typeof value.source === 'string' &&
  value.source.toLowerCase() === repo.toLowerCase();

const invalid = (detail: string): LiveRulesets => ({
  problem: `listing rulesets: GitHub returned ${detail}`,
  rulesets: null,
});

const readSummaries = async (
  token: string | null,
  repo: string,
  page: number,
  previous: ReadonlyArray<Record<string, unknown>>,
): Promise<LiveRulesets> => {
  if (page > MAX_PAGES) {
    return invalid(`more than ${MAX_PAGES * PAGE_SIZE} repository rulesets`);
  }
  const pageResponse = await request(
    token,
    'GET',
    `/repos/${repo}/rulesets?includes_parents=false&per_page=${PAGE_SIZE}&page=${page}`,
  );
  if (pageResponse.status !== HTTP_OK || !Array.isArray(pageResponse.body)) {
    return {
      problem: apiError(`listing rulesets page ${page}`, pageResponse),
      rulesets: null,
    };
  }
  if (!pageResponse.body.every((ruleset) => validIdentity(ruleset, repo))) {
    return invalid(`an invalid repository ruleset identity on page ${page}`);
  }
  const summaries = [...previous, ...pageResponse.body];
  return pageResponse.body.length === PAGE_SIZE
    ? readSummaries(token, repo, page + 1, summaries)
    : { problem: null, rulesets: summaries };
};

const uniqueIdentities = (
  summaries: ReadonlyArray<Readonly<Record<string, unknown>>>,
) =>
  new Set(summaries.map((ruleset) => Number(ruleset.id))).size ===
    summaries.length &&
  new Set(summaries.map((ruleset) => String(ruleset.name))).size ===
    summaries.length;

const readDetails = async (
  token: string | null,
  repo: string,
  summaries: ReadonlyArray<Record<string, unknown>>,
): Promise<LiveRulesets> => {
  const details = await Promise.all(
    summaries.map((ruleset) =>
      request(token, 'GET', `/repos/${repo}/rulesets/${ruleset.id}`),
    ),
  );
  const failed = details.find((detail) => detail.status !== HTTP_OK);
  if (failed !== undefined) {
    return { problem: apiError('reading a ruleset', failed), rulesets: null };
  }
  if (!details.every((detail) => validIdentity(detail.body, repo))) {
    return invalid('an invalid detailed repository ruleset identity');
  }
  return {
    problem: null,
    rulesets: details.map((detail) => detail.body as Record<string, unknown>),
  };
};

export const fetchLiveRulesets = async (
  token: string | null,
  repo: string,
): Promise<LiveRulesets> => {
  const summaryRead = await readSummaries(token, repo, 1, []);
  if (summaryRead.rulesets === null) {
    return summaryRead;
  }
  if (!uniqueIdentities(summaryRead.rulesets)) {
    return invalid('duplicate repository ruleset identities');
  }
  return readDetails(token, repo, summaryRead.rulesets);
};
