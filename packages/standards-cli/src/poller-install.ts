// `standards poller --install`: systemd user units for mutable distros. On
// NixOS this command refuses by design — host provisioning there belongs to
// the declarative infra repository, which wires the same tick command into a
// systemd module. `--print-units` serves both worlds: it emits the unit text
// without touching the host, so declarative configs can consume it.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { PollerConfig } from './poller-config';

const SERVICE_NAME = 'standards-poller';
const TICK_INTERVAL_MINUTES = 10;
// Non-agent tick work: stale sweeps, clone/fetch, GitHub reads and writes.
const TICK_OVERHEAD_MINUTES = 30;
const NIXOS_OS_RELEASE_ID = /^ID=nixos$/mu;

export const isNixOs = async (): Promise<boolean> => {
  if (existsSync('/etc/NIXOS')) {
    return true;
  }
  if (!existsSync('/etc/os-release')) {
    return false;
  }
  const release = await readFile('/etc/os-release', 'utf8');
  return NIXOS_OS_RELEASE_ID.test(release);
};

const cliEntryPath = (): string =>
  fileURLToPath(new URL('cli.ts', import.meta.url));

// The tick budget follows the config — every job may use the full agent
// timeout — so raising "runTimeoutMinutes" or "maxJobsPerTick" cannot
// silently outgrow the unit. Changing either means re-rendering the units.
const tickBudgetMinutes = (config: PollerConfig): number =>
  config.maxJobsPerTick * config.runTimeoutMinutes + TICK_OVERHEAD_MINUTES;

export const renderUnits = (
  configPath: string,
  config: PollerConfig,
): { readonly service: string; readonly timer: string } => ({
  service: `[Unit]
Description=Standards fix poller tick
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${process.execPath} ${cliEntryPath()} poller --config ${configPath}
TimeoutStartSec=${tickBudgetMinutes(config)}min
`,
  timer: `[Unit]
Description=Run the standards fix poller on an interval

[Timer]
OnBootSec=2min
OnUnitActiveSec=${TICK_INTERVAL_MINUTES}min
Persistent=true

[Install]
WantedBy=timers.target
`,
});

export const runPollerPrintUnits = (
  configPath: string,
  config: PollerConfig,
): void => {
  const units = renderUnits(resolve(configPath), config);
  console.log(`# ${SERVICE_NAME}.service`);
  console.log(units.service);
  console.log(`# ${SERVICE_NAME}.timer`);
  console.log(units.timer);
};

export const runPollerInstall = async (
  configPath: string,
  config: PollerConfig,
): Promise<void> => {
  if (await isNixOs()) {
    throw new Error(
      'standards poller --install refuses to run on NixOS: imperative unit files would fight the declarative system. Wire the tick into your infra repository instead (a systemd service and timer running `standards poller --config ...`); `standards poller --print-units` emits the unit content to adapt.',
    );
  }
  const unitDir = join(homedir(), '.config', 'systemd', 'user');
  await mkdir(unitDir, { recursive: true });
  const units = renderUnits(resolve(configPath), config);
  const servicePath = join(unitDir, `${SERVICE_NAME}.service`);
  const timerPath = join(unitDir, `${SERVICE_NAME}.timer`);
  await writeFile(servicePath, units.service);
  await writeFile(timerPath, units.timer);
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  execFileSync(
    'systemctl',
    ['--user', 'enable', '--now', `${SERVICE_NAME}.timer`],
    { stdio: 'inherit' },
  );
  console.log(
    `standards poller: installed and started ${SERVICE_NAME}.timer (every ${TICK_INTERVAL_MINUTES}min); units at ${dirname(servicePath)}`,
  );
};
