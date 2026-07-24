import { afterEach, expect, it } from 'bun:test';
import { retainEarliestComment } from './poller-comment-reconciliation';

const originalFetch = globalThis.fetch;
const EARLIEST_COMMENT_ID = 10;
const FIRST_DUPLICATE_COMMENT_ID = 12;
const SECOND_DUPLICATE_COMMENT_ID = 13;
const THIRD_DUPLICATE_COMMENT_ID = 11;
const DUPLICATE_COMMENT_IDS = [
  FIRST_DUPLICATE_COMMENT_ID,
  SECOND_DUPLICATE_COMMENT_ID,
  THIRD_DUPLICATE_COMMENT_ID,
] as const;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it('serializes duplicate deletion while retaining the earliest comment', async () => {
  let inFlight = 0;
  let maximumInFlight = 0;
  const deletedIds: Array<number> = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    inFlight += 1;
    maximumInFlight = Math.max(maximumInFlight, inFlight);
    deletedIds.push(Number(new URL(String(input)).pathname.split('/').at(-1)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    inFlight -= 1;
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  await expect(
    retainEarliestComment({ token: 'token', repo: 'owner/repo' }, [
      DUPLICATE_COMMENT_IDS[0],
      EARLIEST_COMMENT_ID,
      ...DUPLICATE_COMMENT_IDS.slice(1),
    ]),
  ).resolves.toBe(EARLIEST_COMMENT_ID);
  expect(maximumInFlight).toBe(1);
  expect(deletedIds).toEqual([...DUPLICATE_COMMENT_IDS]);
  expect(deletedIds).not.toContain(EARLIEST_COMMENT_ID);
});
