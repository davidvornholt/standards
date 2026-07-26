import { describe, expect, it } from 'bun:test';
import type { CloudflareToken } from './creds-cloudflare-api';
import { computeCredsPlan } from './creds-plan';
import { keys, NOW, REPO, token } from './creds-plan-test-support';
import { partitionAccountTokens } from './creds-plan-unmanaged';

const withStatus = (
  name: string,
  status: string,
): { accountId: string; token: CloudflareToken } => ({
  accountId: 'a',
  token: { ...token(name, null), status },
});

const entry = (name: string) => withStatus(name, 'active');

describe('account token partitioning', () => {
  it('reports a token the broker did not mint', () => {
    const partition = partitionAccountTokens([entry('hand-made')], REPO);
    expect(partition.managed).toEqual([]);
    expect(partition.findings).toEqual([]);
    expect(partition.unmanaged).toEqual([
      {
        accountId: 'a',
        tokenId: 'id-hand-made',
        name: 'hand-made',
        status: 'active',
      },
    ]);
  });

  it('keeps a brokered token of this repository managed and unreported', () => {
    const partition = partitionAccountTokens(
      [entry(`standards/${REPO}/ci/ci.dns_token`)],
      REPO,
    );
    expect(partition.unmanaged).toEqual([]);
    expect(partition.managed).toHaveLength(1);
    expect(partition.managed[0]?.ref).toEqual({
      repo: REPO,
      target: 'ci',
      key: 'ci.dns_token',
    });
  });

  it('reports another repository brokered token separately from unmanaged', () => {
    const partition = partitionAccountTokens(
      [entry('standards/other/repo/ci/ci.dns_token')],
      REPO,
    );
    expect(partition.managed).toEqual([]);
    expect(partition.unmanaged).toEqual([]);
    expect(partition.findings).toEqual([]);
    expect(partition.brokeredElsewhere).toEqual([
      {
        accountId: 'a',
        tokenId: 'id-standards/other/repo/ci/ci.dns_token',
        name: 'standards/other/repo/ci/ci.dns_token',
        status: 'active',
        repo: 'other/repo',
      },
    ]);
  });

  it('omits an expired foreign token so live ones stay visible', () => {
    const partition = partitionAccountTokens(
      [withStatus('hand-made', 'expired'), withStatus('other', 'disabled')],
      REPO,
    );
    expect(partition.unmanaged.map((found) => found.name)).toEqual(['other']);
    expect(partition.unmanaged[0]?.status).toBe('disabled');
  });

  it('makes a name claiming this repository namespace a finding', () => {
    const partition = partitionAccountTokens(
      [entry(`standards/${REPO}/ci`)],
      REPO,
    );
    expect(partition.unmanaged).toEqual([]);
    expect(partition.findings).toEqual([
      expect.stringContaining(
        "claims this repository's brokered namespace but is not a name this broker mints",
      ),
    ]);
  });
});

describe('creds plan unmanaged reporting', () => {
  it('reports foreign tokens without planning any action against them', () => {
    const plan = computeCredsPlan({
      repo: REPO,
      keysByTarget: keys({ ci: ['ci.dns_token'] }),
      tokens: [
        {
          accountId: 'a',
          token: token(
            `standards/${REPO}/ci/ci.dns_token`,
            '2027-01-01T00:00:00Z',
          ),
        },
        entry('hand-made-token'),
      ],
      now: NOW,
    });
    expect(plan.actions).toEqual([]);
    expect(plan.findings).toEqual([]);
    expect(plan.healthy).toBe(1);
    expect(plan.unmanaged.map((found) => found.name)).toEqual([
      'hand-made-token',
    ]);
  });

  // A partition finding must reach the plan, because that is what aborts
  // `apply`: a name squatting the repository's namespace could otherwise be
  // reconciled around silently, in both output channels and in the exit code.
  it('carries a namespace-squatting finding into the plan', () => {
    const plan = computeCredsPlan({
      repo: REPO,
      keysByTarget: keys({ ci: ['ci.dns_token'] }),
      tokens: [entry(`standards/${REPO}/ci`)],
      now: NOW,
    });
    expect(plan.findings).toEqual([
      expect.stringContaining(
        "claims this repository's brokered namespace but is not a name this broker mints",
      ),
    ]);
    expect(plan.actions).toEqual([]);
    expect(plan.unmanaged).toEqual([]);
  });
});
