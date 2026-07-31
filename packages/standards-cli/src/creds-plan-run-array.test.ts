import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runCredsPlan } from './creds-plan-run';
import {
  cleanupPlanRun,
  initialize,
  stubCloudflare,
} from './creds-plan-run-test-support';

afterEach(cleanupPlanRun);

describe('creds plan/apply array inventory', () => {
  it('reconciles an S3 pair beside an encrypted brokered-reference allowlist', async () => {
    const secrets = `brokeredReferences:
  - ENC[AES256_GCM,data:allowlist,type:str]
r2:
  pair:
    access_key_id: ENC[AES256_GCM,data:id,type:str]
    secret_access_key: ENC[AES256_GCM,data:secret,type:str]
sops:
  mac: ENC[AES256_GCM,data:mac,type:str]
`;
    const { consumer, events } = initialize(secrets);
    stubCloudflare('ci', 'bootstrap', [
      { id: 'bootstrap', name: 'standards-broker', status: 'active' },
      {
        id: 's3-pair',
        name: 'standards/davidvornholt/example/ci/r2.pair',
        status: 'active',
      },
    ]);

    expect(await runCredsPlan(consumer, true)).toBe(true);
    expect(readFileSync(events, 'utf8')).toBe('');
  });
});
