import { describe, expect, it } from 'bun:test';
import type { PollerConfig } from './poller-config';
import { quoteSystemdExecArg, renderUnits } from './poller-units';

const config = (overrides: Partial<PollerConfig> = {}): PollerConfig => ({
  repos: ['owner/repo'],
  model: 'gpt-5.6-sol',
  reasoningEffort: 'high',
  maxJobsPerTick: 1,
  staleClaimHours: 6,
  runTimeoutMinutes: 240,
  cacheDir: '/var/cache/standards-poller',
  extraCodexArgs: [],
  ...overrides,
});

describe('renderUnits', () => {
  it('renders a oneshot service running a tick against the config', () => {
    const { service, timer, acknowledgementService, acknowledgementTimer } =
      renderUnits('/etc/standards-poller/config.json', config());
    expect(service).toContain('Type=oneshot');
    expect(service).toContain(
      'poller --config "/etc/standards-poller/config.json"',
    );
    expect(timer).toContain('OnUnitInactiveSec=1min');
    expect(timer).not.toContain('OnUnitActiveSec');
    expect(timer).toContain('AccuracySec=15s');
    expect(timer).toContain('Persistent=true');
    expect(acknowledgementService).toContain('Type=oneshot');
    expect(acknowledgementService).toContain(
      'poller --acknowledge-only --config "/etc/standards-poller/config.json"',
    );
    expect(acknowledgementService).toContain('TimeoutStartSec=30min');
    expect(acknowledgementTimer).toContain('OnBootSec=1min');
    expect(acknowledgementTimer).toContain('OnUnitInactiveSec=1min');
  });

  it('derives the tick budget from job count and agent timeout', () => {
    const { service } = renderUnits(
      '/etc/standards-poller/config.json',
      config({ maxJobsPerTick: 2, runTimeoutMinutes: 240 }),
    );
    expect(service).toContain('TimeoutStartSec=510min');
  });

  it('quotes paths and escapes systemd expansion sigils', () => {
    const { service } = renderUnits(
      '/srv/poller config/$current/%i\\config.json',
      config(),
    );
    expect(service).toContain(
      'poller --config "/srv/poller config/$$current/%%i\\\\config.json"',
    );
  });

  it('rejects control characters in ExecStart arguments', () => {
    expect(() => quoteSystemdExecArg('/tmp/a\nb')).toThrow(
      'systemd ExecStart arguments cannot contain control characters',
    );
  });
});
