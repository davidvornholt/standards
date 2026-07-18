import { describe, expect, it } from 'bun:test';
import { renderUnits } from './poller-install';

describe('renderUnits', () => {
  it('renders a oneshot service running a tick against the config', () => {
    const { service, timer } = renderUnits('/etc/standards-poller/config.json');
    expect(service).toContain('Type=oneshot');
    expect(service).toContain(
      'poller --config /etc/standards-poller/config.json',
    );
    expect(timer).toContain('OnUnitActiveSec=10min');
    expect(timer).toContain('Persistent=true');
  });
});
