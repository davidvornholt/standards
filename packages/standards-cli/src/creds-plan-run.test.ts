import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runCredsPlan } from './creds-plan-run';
import {
  cleanupPlanRun,
  ENCRYPTED_SECRETS,
  initialize,
  installSops,
  planRunRoot,
  stubCloudflare,
} from './creds-plan-run-test-support';

afterEach(cleanupPlanRun);

describe('creds plan/apply safety', () => {
  it.each([
    ['malformed YAML', 'ci: [\n'],
    ['missing SOPS metadata', 'ci:\n  token: plaintext\n'],
  ])('aborts on %s without provider mutation', async (_, secrets) => {
    const { consumer, events } = initialize(secrets);
    stubCloudflare();
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runCredsPlan(consumer, true)).toBe(false);
    expect(readFileSync(events, 'utf8')).toBe('');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('reconciliation aborted'),
    );
  });
  it.each([
    ['flat', 'ci', 'secrets/ci.yaml'],
    ['host', 'prod', 'infra/hosts/prod/secrets.yaml'],
  ] as const)('aborts on an unsafe %s target without provider deletion', async (kind, target, rel) => {
    const { consumer, events } = initialize(ENCRYPTED_SECRETS);
    const outside = join(planRunRoot(), `outside-${kind}`);
    if (kind === 'flat') {
      writeFileSync(outside, 'outside\n');
      rmSync(join(consumer, rel));
      symlinkSync(outside, join(consumer, rel));
    } else {
      mkdirSync(outside);
      mkdirSync(join(consumer, 'infra', 'hosts'), { recursive: true });
      symlinkSync(outside, join(consumer, 'infra', 'hosts', target), 'dir');
    }
    stubCloudflare(target);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runCredsPlan(consumer, true)).toBe(false);
    expect(readFileSync(events, 'utf8')).toBe('');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(`unsafe encrypted secrets target ${rel}`),
    );
  });
  it('cleans a replacement and preserves the old token on write failure', async () => {
    const { consumer, events } = initialize(ENCRYPTED_SECRETS);
    installSops(
      'if [ "$1" = "decrypt" ]; then printf \'"old-value"\'; exit 0; fi\nexit 1',
    );
    stubCloudflare();
    expect(await runCredsPlan(consumer, true)).toBe(false);
    expect(readFileSync(events, 'utf8').trim().split('\n')).toEqual([
      'create',
      'delete-replacement',
    ]);
  });
  it('writes and verifies the replacement before revoking the old token', async () => {
    const { consumer, events } = initialize(ENCRYPTED_SECRETS);
    installSops(
      'if [ "$1" = "decrypt" ]; then printf \'"new-value"\'; exit 0; fi\neval "$SOPS_EDITOR \\"$2\\"" && printf "write\\n" >> "$PLAN_EVENT_FILE"',
    );
    stubCloudflare();
    expect(await runCredsPlan(consumer, true)).toBe(true);
    expect(readFileSync(events, 'utf8').trim().split('\n')).toEqual([
      'create',
      'write',
      'delete-old',
    ]);
  });
});
