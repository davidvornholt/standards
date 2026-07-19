// Exhaustive pagination for GitHub list endpoints. Single-page reads are a
// correctness hazard everywhere the caller needs "the latest" or "all" of
// something: a truncated timeline mis-attributes label approvals, truncated
// comments break answer detection, and truncated label lists read as drift.
// Overflow past the page cap fails loudly instead of silently truncating.

import { type ApiResponse, apiError, HTTP_OK, request } from './github-api';

const PAGE_SIZE = 100;
const MAX_PAGES = 30;

export class GithubListResponseError extends Error {
  readonly status: number;

  constructor(context: string, response: ApiResponse) {
    super(apiError(context, response));
    this.name = 'GithubListResponseError';
    this.status = response.status;
  }
}

export const listAllPages = async (
  token: string | null,
  path: string,
  context: string,
): Promise<ReadonlyArray<unknown>> => {
  const items: Array<unknown> = [];
  const separator = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: pages are sequential by definition; the next request needs to know the previous page was full.
    const response = await request(
      token,
      'GET',
      `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`,
    );
    if (response.status !== HTTP_OK || !Array.isArray(response.body)) {
      throw new GithubListResponseError(context, response);
    }
    items.push(...response.body);
    if (response.body.length < PAGE_SIZE) {
      return items;
    }
  }
  throw new Error(
    `${context}: more than ${MAX_PAGES * PAGE_SIZE} items; refusing to act on a truncated list`,
  );
};
