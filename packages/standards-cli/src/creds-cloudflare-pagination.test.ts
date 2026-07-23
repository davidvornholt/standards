import { afterEach, describe, expect, it } from 'bun:test';
import { listAccountTokens } from './creds-cloudflare';

const ACCOUNT_ID_LENGTH = 32;
const ACCOUNT = 'a'.repeat(ACCOUNT_ID_LENGTH);
const originalFetch = globalThis.fetch;
const requestedPages: Array<number> = [];

const info = (page: number, count: number, total: number): unknown => ({
  page,
  // biome-ignore lint/style/useNamingConvention: Cloudflare's pagination field is snake_case.
  per_page: 50,
  count,
  // biome-ignore lint/style/useNamingConvention: Cloudflare's pagination field is snake_case.
  total_count: total,
});

const response = (
  result: ReadonlyArray<Readonly<Record<string, unknown>>>,
  resultInfo: unknown,
): Response =>
  Response.json({
    success: true,
    errors: [],
    result,
    // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
    result_info: resultInfo,
  });

const stubPages = (
  pages: ReadonlyArray<{
    readonly result: ReadonlyArray<Readonly<Record<string, unknown>>>;
    readonly total: number;
  }>,
): void => {
  globalThis.fetch = ((input: string | URL | Request) => {
    const page = Number(new URL(String(input)).searchParams.get('page'));
    requestedPages.push(page);
    const current = pages[page - 1] ?? { result: [], total: 0 };
    return Promise.resolve(
      response(
        current.result,
        info(page, current.result.length, current.total),
      ),
    );
  }) as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  requestedPages.length = 0;
});

describe('Cloudflare token pagination completeness', () => {
  it('continues after a short page until total_count is reached', async () => {
    stubPages([
      { result: [{ id: 'first', name: 'first' }], total: 2 },
      { result: [{ id: 'second', name: 'second' }], total: 2 },
    ]);
    const listed = await listAccountTokens(ACCOUNT, 'bootstrap');
    expect(listed).toEqual({
      ok: true,
      value: [
        expect.objectContaining({ id: 'first' }),
        expect.objectContaining({ id: 'second' }),
      ],
    });
    expect(requestedPages).toEqual([1, 2]);
  });

  it('fails closed when an incomplete listing makes no progress', async () => {
    stubPages([
      { result: [{ id: 'first', name: 'first' }], total: 2 },
      { result: [], total: 2 },
    ]);
    expect(await listAccountTokens(ACCOUNT, 'bootstrap')).toEqual({
      ok: false,
      problem: expect.stringContaining('no unique progress'),
    });
  });

  it('fails closed when total_count changes between pages', async () => {
    stubPages([
      { result: [{ id: 'first', name: 'first' }], total: 2 },
      { result: [{ id: 'second', name: 'second' }], total: 3 },
    ]);
    expect(await listAccountTokens(ACCOUNT, 'bootstrap')).toEqual({
      ok: false,
      problem: expect.stringContaining('inconsistent total_count'),
    });
  });
});
