import { describe, expect, it } from 'bun:test';
import { computeCredsPlan } from './creds-plan';
import { keys, NOW, REPO, token } from './creds-plan-test-support';

describe('creds plan destination footprint safeguards', () => {
  for (const leaf of ['access_key_id', 'secret_access_key']) {
    for (const reversed of [false, true]) {
      it(`fails closed on intersecting S3 base/${leaf} footprints${reversed ? ' in reverse discovery order' : ''}`, () => {
        const entries = [
          {
            accountId: 'a',
            token: {
              ...token(`standards/${REPO}/ci/ci.r2`, '2026-08-01T00:00:00Z'),
              id: 'base',
            },
          },
          {
            accountId: 'b',
            token: {
              ...token(
                `standards/${REPO}/ci/ci.r2.${leaf}`,
                '2026-08-01T00:00:00Z',
              ),
              id: 'leaf',
            },
          },
        ];
        const plan = computeCredsPlan({
          repo: REPO,
          keysByTarget: keys({
            ci: ['ci.r2.access_key_id', 'ci.r2.secret_access_key'],
          }),
          tokens: reversed ? entries.toReversed() : entries,
          now: NOW,
        });
        expect(plan.actions).toEqual([]);
        expect(plan.healthy).toBe(0);
        expect(plan.findings).toEqual([
          expect.stringContaining('destination footprints intersect'),
        ]);
      });
    }
  }
});
