import {
  type CfResult,
  type CloudflareToken,
  type ResultInfo,
  tokenOf,
} from './creds-cloudflare-api';

export const decodeCloudflareTokenPage = (
  result: unknown,
): CfResult<ReadonlyArray<CloudflareToken>> => {
  if (!Array.isArray(result)) {
    return { ok: false, problem: 'token list returned a non-array result' };
  }
  const tokens = result
    .map(tokenOf)
    .filter((entry): entry is CloudflareToken => entry !== null);
  return tokens.length === result.length
    ? { ok: true, value: tokens }
    : { ok: false, problem: 'token list returned a malformed token' };
};

export const cloudflarePaginationProblem = (input: {
  readonly page: number;
  readonly resultLength: number;
  readonly resultInfo: ResultInfo;
  readonly accumulated: number;
  readonly expectedTotal: number;
  readonly duplicate: boolean;
}): string | null => {
  if (
    input.resultInfo.page !== input.page ||
    input.resultInfo.count !== input.resultLength
  ) {
    return `token list returned inconsistent pagination metadata for page ${input.page}`;
  }
  if (
    input.resultInfo.totalCount !== input.expectedTotal ||
    input.accumulated + input.resultLength > input.expectedTotal
  ) {
    return `token list returned an inconsistent total_count for page ${input.page}`;
  }
  if (
    input.duplicate ||
    (input.resultLength === 0 && input.accumulated < input.expectedTotal)
  ) {
    return `token list made no unique progress on page ${input.page}`;
  }
  return null;
};
