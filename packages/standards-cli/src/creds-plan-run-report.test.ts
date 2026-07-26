// The listing is the only channel through which a token nothing reconciles
// becomes visible: plan and apply never mutate these tokens, so losing the
// output loses the whole feature while the command still exits 0. Pinned end to
// end through `runCredsPlan` — each block reaches stdout, carries the exact
// command that retires the token it names, and the summary counts "nobody mints
// this shape" apart from "another repository owns this".

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { runCredsPlan } from './creds-plan-run';
import {
  ACCOUNT,
  cleanupPlanRun,
  ENCRYPTED_SECRETS,
  initialize,
  stubCloudflare,
} from './creds-plan-run-test-support';

const ID_LENGTH = 32;
const FOREIGN_ID = `a${'1'.repeat(ID_LENGTH - 1)}`;
const EXPIRED_ID = `b${'2'.repeat(ID_LENGTH - 1)}`;
const ELSEWHERE_ID = `c${'3'.repeat(ID_LENGTH - 1)}`;
const ELSEWHERE_NAME = 'standards/otherowner/otherrepo/ci/ci.dns_token';

const LISTING = [
  { id: 'bootstrap', name: 'standards-broker', status: 'active' },
  { id: FOREIGN_ID, name: 'dns-token-from-2023', status: 'active' },
  { id: EXPIRED_ID, name: 'retired-deploy-token', status: 'expired' },
  { id: ELSEWHERE_ID, name: ELSEWHERE_NAME, status: 'active' },
];

const lineWith = (printed: ReadonlyArray<string>, needle: string): string =>
  printed.find((line) => line.includes(needle)) ?? '(no line printed)';

afterEach(cleanupPlanRun);

describe('creds plan reporting', () => {
  it('lists every token nothing reconciles with the command that retires it', async () => {
    const { consumer } = initialize(ENCRYPTED_SECRETS);
    stubCloudflare('ci', 'bootstrap', LISTING);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runCredsPlan(consumer, false)).toBe(true);

    const printed = log.mock.calls.map((call) => String(call[0]));
    const unmanaged = lineWith(printed, 'dns-token-from-2023');
    expect(unmanaged).toContain('(active)');
    expect(unmanaged).toContain(
      `standards creds revoke --account ${ACCOUNT} --token-id ${FOREIGN_ID}`,
    );
    const elsewhere = lineWith(printed, ELSEWHERE_NAME);
    expect(elsewhere).toContain('otherowner/otherrepo');
    expect(elsewhere).toContain(
      `standards creds revoke --account ${ACCOUNT} --token-id ${ELSEWHERE_ID} --force`,
    );
  });

  it('counts a foreign token apart from one brokered elsewhere, and hides neither the bootstrap nor an expired token', async () => {
    const { consumer } = initialize(ENCRYPTED_SECRETS);
    stubCloudflare('ci', 'bootstrap', LISTING);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runCredsPlan(consumer, false)).toBe(true);

    const printed = log.mock.calls.map((call) => String(call[0]));
    const summary = lineWith(printed, 'action(s)');
    expect(summary).toContain('1 unmanaged token(s)');
    expect(summary).toContain('1 token(s) brokered to another repository');
    expect(printed.join('\n')).not.toContain('standards-broker');
    expect(printed.join('\n')).not.toContain('retired-deploy-token');
  });
});
