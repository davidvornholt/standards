import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runCredsPlan } from './creds-plan-run';
import {
  cleanupPlanRun,
  ENCRYPTED_SECRETS,
  initialize,
  installSops,
  stubCloudflare,
} from './creds-plan-run-test-support';

afterEach(cleanupPlanRun);

describe('creds apply verification mismatch', () => {
  it('names the known-bad stored value when verification mismatches after a claimed-successful write', async () => {
    const { consumer, events } = initialize(ENCRYPTED_SECRETS);
    installSops(
      'if [ "$1" = "decrypt" ]; then printf \'"tampered-value"\'; exit 0; fi\neval "$SOPS_EDITOR \\"$2\\"" && printf "write\\n" >> "$PLAN_EVENT_FILE"',
    );
    stubCloudflare();
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runCredsPlan(consumer, true)).toBe(false);
    expect(readFileSync(events, 'utf8').trim().split('\n')).toEqual([
      'create',
      'write',
      'delete-replacement',
    ]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        'matching neither the old nor the replacement token',
      ),
    );
  });
});
