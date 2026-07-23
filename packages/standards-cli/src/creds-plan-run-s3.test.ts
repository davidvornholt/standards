import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCredsPlan } from './creds-plan-run';
import {
  cleanupPlanRun,
  initialize,
  installSops,
  stubCloudflare,
} from './creds-plan-run-test-support';

const S3_SECRETS =
  'ci:\n  token:\n    access_key_id: ENC[AES256_GCM,data:a]\n    secret_access_key: ENC[AES256_GCM,data:b]\nsops:\n  mac: ENC[AES256_GCM,data:y]\n';
// printf '%s' 'new-value' | sha256sum
const NEW_VALUE_SHA =
  '288167617f1895a847dfed3528d16fec28231e956663243d71477da5b0a2a51e';

afterEach(cleanupPlanRun);

describe('creds apply S3 pair renewal', () => {
  it('renews an expiring S3 destination by rewriting the derived pair before revoking', async () => {
    const { consumer, events } = initialize(S3_SECRETS);
    installSops(
      `if [ "$1" = "decrypt" ]; then\n  case "$3" in\n    *access_key_id*) printf '"replacement"' ;;\n    *) printf '"${NEW_VALUE_SHA}"' ;;\n  esac\n  exit 0\nfi\neval "$SOPS_EDITOR \\"$2\\"" && printf "write\\n" >> "$PLAN_EVENT_FILE"`,
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
});
