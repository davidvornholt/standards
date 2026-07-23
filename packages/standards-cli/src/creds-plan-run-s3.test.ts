import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCredsPlan } from './creds-plan-run';
import {
  ACCOUNT,
  cleanupPlanRun,
  initialize,
  installSops,
  stubCloudflare,
} from './creds-plan-run-test-support';

const S3_SECRETS =
  'ci:\n  token:\n    access_key_id: ENC[AES256_GCM,data:a]\n    secret_access_key: ENC[AES256_GCM,data:b]\nsops:\n  mac: ENC[AES256_GCM,data:y]\n';
const OVERLAP_S3_SECRETS =
  'ci:\n  r2:\n    access_key_id: ENC[AES256_GCM,data:a]\n    secret_access_key: ENC[AES256_GCM,data:b]\nsops:\n  mac: ENC[AES256_GCM,data:y]\n';
// printf '%s' 'new-value' | sha256sum
const NEW_VALUE_SHA =
  '288167617f1895a847dfed3528d16fec28231e956663243d71477da5b0a2a51e';
const DAY_MS = 86_400_000;
const EXPIRING_IN_DAYS = 10;
const TOKEN_TTL_DAYS = 90;

afterEach(cleanupPlanRun);

describe('creds apply S3 pair renewal', () => {
  for (const leaf of ['access_key_id', 'secret_access_key']) {
    it(`does not mutate intersecting expiring S3 base/${leaf} tokens`, async () => {
      const { consumer, events } = initialize(OVERLAP_S3_SECRETS);
      installSops('printf "write\\n" >> "$PLAN_EVENT_FILE"\nexit 1');
      const mutationMethods: Array<string> = [];
      const expires = Date.now() + EXPIRING_IN_DAYS * DAY_MS;
      const token = (key: string, id: string): unknown => ({
        id,
        name: `standards/davidvornholt/example/ci/${key}`,
        status: 'active',
        // biome-ignore lint/style/useNamingConvention: Cloudflare's token field is snake_case.
        expires_on: new Date(expires).toISOString(),
        // biome-ignore lint/style/useNamingConvention: Cloudflare's token field is snake_case.
        issued_on: new Date(expires - TOKEN_TTL_DAYS * DAY_MS).toISOString(),
        policies: [
          {
            effect: 'allow',
            resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: '*' },
            // biome-ignore lint/style/useNamingConvention: Cloudflare's policy field is snake_case.
            permission_groups: [{ id: 'pg' }],
          },
        ],
      });
      globalThis.fetch = ((
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (method === 'POST' || method === 'DELETE') {
          mutationMethods.push(method);
        }
        const result = url.endsWith('/verify')
          ? { id: 'bootstrap', status: 'active' }
          : [
              { id: 'bootstrap', name: 'standards-broker', status: 'active' },
              token('ci.r2', 'base'),
              token(`ci.r2.${leaf}`, 'leaf'),
            ];
        return Promise.resolve(
          Response.json({
            success: true,
            errors: [],
            result,
            ...(Array.isArray(result)
              ? {
                  // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
                  result_info: {
                    page: 1,
                    // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
                    per_page: 50,
                    count: result.length,
                    // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
                    total_count: result.length,
                  },
                }
              : {}),
          }),
        );
      }) as typeof fetch;
      const error = spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await runCredsPlan(consumer, true)).toBe(false);
      expect(mutationMethods).toEqual([]);
      expect(readFileSync(events, 'utf8')).toBe('');
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('destination footprints intersect'),
      );
    });
  }

  it('renews an expiring S3 destination by rewriting the derived pair before revoking', async () => {
    const { consumer, events } = initialize(S3_SECRETS);
    installSops(
      `if [ "$1" = "decrypt" ]; then\n  case "$3" in\n    *access_key_id*) if [ -s "$PLAN_EVENT_FILE" ]; then printf '"replacement"'; else printf '"old"'; fi ;;\n    *) printf '"${NEW_VALUE_SHA}"' ;;\n  esac\n  exit 0\nfi\neval "$SOPS_EDITOR \\"$2\\"" && printf "write\\n" >> "$PLAN_EVENT_FILE"`,
    );
    stubCloudflare();
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runCredsPlan(consumer, true)).toBe(true);
    expect(readFileSync(events, 'utf8').trim().split('\n')).toEqual([
      'create',
      'write',
      'delete-old',
    ]);
    const secrets = readFileSync(join(consumer, 'secrets', 'ci.yaml'), 'utf8');
    expect(secrets).toContain('access_key_id: replacement');
    expect(secrets).toContain(`secret_access_key: ${NEW_VALUE_SHA}`);
    expect(log.mock.calls.join(' ')).not.toContain('new-value');
  });

  it('does not mutate when the stored access key belongs to another token', async () => {
    const { consumer, events } = initialize(S3_SECRETS);
    installSops(
      'if [ "$1" = "decrypt" ]; then printf \'"foreign-token"\'; exit 0; fi\nprintf "write\\n" >> "$PLAN_EVENT_FILE"',
    );
    stubCloudflare();
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runCredsPlan(consumer, true)).toBe(false);
    expect(readFileSync(events, 'utf8')).toBe('');
    expect(error.mock.calls.join(' ')).not.toContain('foreign-token');
    expect(existsSync(events)).toBe(true);
  });
});
