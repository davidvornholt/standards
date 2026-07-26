// Shared account stub for the `creds revoke` suites. One account holds every
// class the command has to tell apart: this machine's bootstrap credential,
// another machine's under the same reserved name, a hand-made token, a token
// brokered to the consumer repository, one brokered to a foreign one, one
// brokered under the consumer's repository name but a different owner, and a
// bootstrap credential renamed out of the reserved name.

import { pageInfo, response } from './creds-add-test-support';

const ID_LENGTH = 32;
export const BOOTSTRAP_ID = `f${'0'.repeat(ID_LENGTH - 1)}`;
export const FOREIGN_ID = `a${'1'.repeat(ID_LENGTH - 1)}`;
export const BROKERED_ID = `b${'2'.repeat(ID_LENGTH - 1)}`;
export const MISSING_ID = `c${'3'.repeat(ID_LENGTH - 1)}`;
export const OTHER_REPO_ID = `d${'4'.repeat(ID_LENGTH - 1)}`;
// Same repository name as the consumer, different owner. GitHub names are
// case-insensitive but owner-scoped, so an ownership check that compares only
// the repository name would hand this foreign token the owner's remedy.
export const OTHER_OWNER_ID = `1${'8'.repeat(ID_LENGTH - 1)}`;
export const OTHER_MACHINE_BROKER_ID = `e${'5'.repeat(ID_LENGTH - 1)}`;
export const MALFORMED_ID = `0${'6'.repeat(ID_LENGTH - 1)}`;
// A bootstrap credential someone renamed in the dashboard. Passed as
// `verifiedId`, it is this machine's own bootstrap under a name the reserved-name
// guard does not catch, which is the only way to exercise the ID-based guard on
// its own. It sits last in the listing so a positional match cannot stand in
// for the identity match.
export const RENAMED_BOOTSTRAP_ID = `9${'7'.repeat(ID_LENGTH - 1)}`;

const ACCOUNT_TOKENS = [
  { id: BOOTSTRAP_ID, name: 'standards-broker', status: 'active' },
  { id: OTHER_MACHINE_BROKER_ID, name: 'standards-broker', status: 'active' },
  { id: FOREIGN_ID, name: 'dns-token-from-2023', status: 'active' },
  {
    id: BROKERED_ID,
    name: 'standards/davidvornholt/example/ci/ci.dns_token',
    status: 'active',
  },
  {
    id: OTHER_REPO_ID,
    name: 'standards/otherowner/otherrepo/ci/ci.dns_token',
    status: 'active',
  },
  {
    id: OTHER_OWNER_ID,
    name: 'standards/otherowner/example/ci/ci.dns_token',
    status: 'active',
  },
  // In the repository's own namespace but not a name the broker mints. `plan`
  // tells the operator to retire exactly this with `revoke`, so it must stay
  // revocable.
  {
    id: MALFORMED_ID,
    name: 'standards/davidvornholt/example/ci',
    status: 'active',
  },
  {
    id: RENAMED_BOOTSTRAP_ID,
    name: 'cloudflare-token-2022',
    status: 'active',
  },
];

const FORBIDDEN = 403;

// Returns the request log so a suite can assert that a refusal issued no
// DELETE at all, not merely that the command reported failure. `verifiedId`
// null drops the ID from the verify response, which is how the provider looks
// when bootstrap identity cannot be established.
export const stubAccount = (
  options: {
    readonly denyDelete?: boolean;
    readonly verifiedId?: string | null;
  } = {},
): Array<string> => {
  const { denyDelete = false, verifiedId = BOOTSTRAP_ID } = options;
  const requests: Array<string> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${url}`);
    if (url.endsWith('/verify')) {
      return Promise.resolve(
        response({
          ...(verifiedId === null ? {} : { id: verifiedId }),
          status: 'active',
        }),
      );
    }
    if (method === 'DELETE') {
      return Promise.resolve(
        denyDelete
          ? Response.json(
              {
                success: false,
                errors: [{ message: 'Insufficient permissions' }],
                result: null,
              },
              { status: FORBIDDEN },
            )
          : response({ id: 'deleted' }),
      );
    }
    return Promise.resolve(
      response(
        ACCOUNT_TOKENS,
        pageInfo(ACCOUNT_TOKENS.length, ACCOUNT_TOKENS.length),
      ),
    );
  }) as typeof fetch;
  return requests;
};

export const deletes = (
  requests: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  requests.filter((request) => request.startsWith('DELETE'));

// A refusal is asserted fact by fact — the repository it names, the SOPS key to
// delete, the command to run — rather than as one long span of prose, so a
// reworded sentence stays green while a dropped remedy goes red.
export const refusals = (spy: {
  readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> };
}): ReadonlyArray<string> => spy.mock.calls.map((call) => String(call[0]));
