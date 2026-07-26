// Shared account stub for the `creds revoke` suites. One account holds every
// class the command has to tell apart: this machine's bootstrap credential,
// another machine's under the same reserved name, a hand-made token, a token
// brokered to the consumer repository, and one brokered to a foreign one.

import { pageInfo, response } from './creds-add-test-support';

const ID_LENGTH = 32;
export const BOOTSTRAP_ID = `f${'0'.repeat(ID_LENGTH - 1)}`;
export const FOREIGN_ID = `a${'1'.repeat(ID_LENGTH - 1)}`;
export const BROKERED_ID = `b${'2'.repeat(ID_LENGTH - 1)}`;
export const MISSING_ID = `c${'3'.repeat(ID_LENGTH - 1)}`;
export const OTHER_REPO_ID = `d${'4'.repeat(ID_LENGTH - 1)}`;
export const OTHER_MACHINE_BROKER_ID = `e${'5'.repeat(ID_LENGTH - 1)}`;

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
];

// Returns the request log so a suite can assert that a refusal issued no
// DELETE at all, not merely that the command reported failure.
export const stubAccount = (): Array<string> => {
  const requests: Array<string> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${url}`);
    if (url.endsWith('/verify')) {
      return Promise.resolve(response({ id: BOOTSTRAP_ID, status: 'active' }));
    }
    if (method === 'DELETE') {
      return Promise.resolve(response({ id: 'deleted' }));
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
