// The listing is the only channel through which a token nothing reconciles
// becomes visible: plan and apply never mutate these tokens, so losing the
// output loses the whole feature while the command still exits 0. Pinned end to
// end through `runCredsPlan` — each block reaches stdout under its own labelled
// header, carries the exact command that retires the token it names, and the
// summary counts "nobody mints this shape" apart from "another repository owns
// this".

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { BROKER_IDENTITY_NAME } from './creds-naming';
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
const OTHER_MACHINE_ID = `d${'4'.repeat(ID_LENGTH - 1)}`;
const SECOND_FOREIGN_ID = `e${'5'.repeat(ID_LENGTH - 1)}`;

// Two unmanaged tokens against one brokered elsewhere: with one of each, the
// two summary counts and their labels could be swapped without any assertion
// noticing, and "1 unmanaged, 6 brokered elsewhere" read backwards sends an
// operator at six tokens other repositories still reconcile.
const LISTING = [
  { id: 'bootstrap', name: 'standards-broker', status: 'active' },
  { id: FOREIGN_ID, name: 'dns-token-from-2023', status: 'active' },
  { id: SECOND_FOREIGN_ID, name: 'r2-key-from-2024', status: 'active' },
  { id: EXPIRED_ID, name: 'retired-deploy-token', status: 'expired' },
  { id: ELSEWHERE_ID, name: ELSEWHERE_NAME, status: 'active' },
];

const HEADER_PREFIX = 'standards creds: ';

const lineWith = (printed: ReadonlyArray<string>, needle: string): string =>
  printed.find((line) => line.includes(needle)) ?? '(no line printed)';

// A token row carries no label of its own, so what makes it readable is the
// block header above it. Walking back from the row to the nearest header line
// pins the row to its block: drop a header and the row lands under the previous
// block's label, or under none at all.
const blockHeaderAbove = (
  printed: ReadonlyArray<string>,
  needle: string,
): string => {
  const row = printed.findIndex((line) => line.includes(needle));
  return (
    printed
      .slice(0, Math.max(row, 0))
      .reverse()
      .find((line) => line.startsWith(HEADER_PREFIX)) ?? '(no header printed)'
  );
};

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
    expect(blockHeaderAbove(printed, 'dns-token-from-2023')).toContain(
      'unmanaged tokens',
    );
    const elsewhere = lineWith(printed, ELSEWHERE_NAME);
    expect(elsewhere).toContain('otherowner/otherrepo');
    expect(elsewhere).toContain(
      `standards creds revoke --account ${ACCOUNT} --token-id ${ELSEWHERE_ID} --force`,
    );
    expect(blockHeaderAbove(printed, ELSEWHERE_NAME)).toContain(
      'brokered to another repository',
    );
  });

  // A second machine's bootstrap credential shares the reserved name, so it
  // lands in this listing while `revoke` refuses that name outright. Printing a
  // revoke command here would hand the operator one that always fails.
  it('sends a second broker bootstrap credential to the dashboard, not to revoke', async () => {
    const { consumer } = initialize(ENCRYPTED_SECRETS);
    stubCloudflare('ci', 'bootstrap', [
      ...LISTING,
      { id: OTHER_MACHINE_ID, name: BROKER_IDENTITY_NAME, status: 'active' },
    ]);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runCredsPlan(consumer, false)).toBe(true);

    const printed = log.mock.calls.map((call) => String(call[0]));
    const row = lineWith(printed, BROKER_IDENTITY_NAME);
    expect(row).toContain('Cloudflare dashboard');
    expect(row).not.toContain('standards creds revoke');
    expect(row).not.toContain(OTHER_MACHINE_ID);
  });

  it('counts foreign tokens apart from one brokered elsewhere, and hides neither the bootstrap nor an expired token', async () => {
    const { consumer } = initialize(ENCRYPTED_SECRETS);
    stubCloudflare('ci', 'bootstrap', LISTING);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runCredsPlan(consumer, false)).toBe(true);

    const printed = log.mock.calls.map((call) => String(call[0]));
    const summary = lineWith(printed, 'action(s)');
    expect(summary).toContain('2 unmanaged token(s)');
    expect(summary).toContain('1 token(s) brokered to another repository');
    expect(printed.join('\n')).not.toContain('standards-broker');
    expect(printed.join('\n')).not.toContain('retired-deploy-token');
  });
});
