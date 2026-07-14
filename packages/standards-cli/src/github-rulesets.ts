import { apiError, HTTP_OK, request } from './github-api';
import {
  decodeRepositoryRulesetDetail,
  isRepositoryRulesetIdentity,
} from './github-ruleset-response';

export type LiveRulesets = {
  readonly problem: string | null;
  readonly rulesets: ReadonlyArray<Record<string, unknown>> | null;
};

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

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
  if (
    !pageResponse.body.every((ruleset) =>
      isRepositoryRulesetIdentity(ruleset, repo),
    )
  ) {
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

const detailMatchesSummary = (
  detail: unknown,
  summary: Readonly<Record<string, unknown>>,
  repo: string,
): detail is Record<string, unknown> =>
  isRepositoryRulesetIdentity(detail, repo) &&
  detail.id === summary.id &&
  detail.name === summary.name &&
  String(detail.source).toLowerCase() === String(summary.source).toLowerCase();

const readDetails = async (
  token: string | null,
  repo: string,
  summaries: ReadonlyArray<Record<string, unknown>>,
  detailRequired: boolean,
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
  const decoded = details.map((detail) =>
    decodeRepositoryRulesetDetail(detail.body, repo, detailRequired),
  );
  const failedDecode = decoded.find(({ value }) => value === null);
  if (failedDecode !== undefined) {
    return {
      problem: `listing rulesets: ${failedDecode.problem ?? 'GitHub returned an invalid detailed repository ruleset state'}`,
      rulesets: null,
    };
  }
  const validatedDetails = decoded.flatMap(({ value }) =>
    value === null ? [] : [value],
  );
  if (!uniqueIdentities(validatedDetails)) {
    return invalid('duplicate detailed repository ruleset identities');
  }
  if (
    !validatedDetails.every((detail, index) => {
      const summary = summaries[index];
      return (
        summary !== undefined && detailMatchesSummary(detail, summary, repo)
      );
    })
  ) {
    return invalid(
      'a detailed repository ruleset identity mismatched its summary',
    );
  }
  return {
    problem: null,
    rulesets: validatedDetails,
  };
};

export const fetchLiveRulesets = async (
  token: string | null,
  repo: string,
  detailRequired: boolean,
): Promise<LiveRulesets> => {
  const summaryRead = await readSummaries(token, repo, 1, []);
  if (summaryRead.rulesets === null) {
    return summaryRead;
  }
  if (!uniqueIdentities(summaryRead.rulesets)) {
    return invalid('duplicate repository ruleset identities');
  }
  return readDetails(token, repo, summaryRead.rulesets, detailRequired);
};
