// The merge-settings fallback shares `queryRepository` with the bypass-actor
// count, so every failure shape that must yield no count must also yield no
// merge value: a suppressed `false` beside an errors array would read as
// verified drift, or worse as a verified match.

import { afterEach, describe, expect, it } from 'bun:test';
import { HTTP_FORBIDDEN } from './github-api';
import { graphqlQuery, installApi } from './github-commands-test-support';
import { fetchMergeSettingsViaGraphql } from './github-graphql';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Wire payloads stay JSON so their snake_case keys never become identifiers.
const parsed = (json: string): unknown => JSON.parse(json) as unknown;

const MERGE_KEYS = ['allow_auto_merge', 'delete_branch_on_merge'];

const fetchMerge = async (body: unknown, status?: number) => {
  const calls = installApi([
    status === undefined ? { body } : { status, body },
  ]);
  const settings = await fetchMergeSettingsViaGraphql(
    'token',
    'owner/repo',
    MERGE_KEYS,
  );
  return { calls, settings };
};

describe('fetchMergeSettingsViaGraphql', () => {
  it('maps the answered GraphQL fields back to their REST keys', async () => {
    const answer = await fetchMerge(
      parsed(
        '{"data":{"repository":{"autoMergeAllowed":true,"deleteBranchOnMerge":false}}}',
      ),
    );
    expect(answer.settings).toEqual(
      parsed(
        '{"allow_auto_merge":true,"delete_branch_on_merge":false}',
      ) as Readonly<Record<string, unknown>>,
    );
    const query = graphqlQuery(answer.calls[0]);
    expect(query).toContain('autoMergeAllowed');
    expect(query).toContain('deleteBranchOnMerge');
  });

  // A field GraphQL nulls out is one it did not answer for, so the key has to
  // stay unverifiable rather than compare as a value.
  it('drops a key GraphQL answered with null', async () => {
    const answer = await fetchMerge(
      parsed(
        '{"data":{"repository":{"autoMergeAllowed":null,"deleteBranchOnMerge":true}}}',
      ),
    );
    expect(answer.settings).toEqual(
      parsed('{"delete_branch_on_merge":true}') as Readonly<
        Record<string, unknown>
      >,
    );
  });

  it('asks for nothing when no requested key has a GraphQL equivalent', async () => {
    const calls = installApi([]);
    expect(
      await fetchMergeSettingsViaGraphql('token', 'owner/repo', ['private']),
    ).toEqual({});
    expect(calls).toEqual([]);
  });
});

// The same shapes the bypass-actor count refuses. Each carries a value that
// would otherwise be reported as the live setting.
describe('fetchMergeSettingsViaGraphql fails closed', () => {
  it.each([
    [
      'a partial answer beside an errors array',
      '{"data":{"repository":{"autoMergeAllowed":false,"deleteBranchOnMerge":false}},"errors":[{"type":"FORBIDDEN","message":"Resource not accessible by integration"}]}',
    ],
    ['a null repository', '{"data":{"repository":null}}'],
    ['a body with no data', '{"message":"unexpected"}'],
  ])('reads no setting from %s', async (_case, envelope) => {
    const answer = await fetchMerge(parsed(envelope));
    expect(answer.settings).toEqual({});
  });

  it('reads no setting when the request itself failed', async () => {
    const answer = await fetchMerge(
      parsed('{"message":"Resource not accessible by integration"}'),
      HTTP_FORBIDDEN,
    );
    expect(answer.settings).toEqual({});
  });

  it('makes no request for a repository that is not owner/name', async () => {
    const calls = installApi([]);
    expect(
      await fetchMergeSettingsViaGraphql('token', 'repo', MERGE_KEYS),
    ).toEqual({});
    expect(calls).toEqual([]);
  });
});
