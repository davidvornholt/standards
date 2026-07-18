// Declarative systemd unit rendering for the host infrastructure repository.
// This command only prints content: host mutation belongs to trusted
// main-branch automation in the repository that owns the polling host.

import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { PollerConfig } from './poller-config';

const SERVICE_NAME = 'standards-poller';
const TICK_INTERVAL_MINUTES = 10;
// Non-agent tick work: stale sweeps, clone/fetch, GitHub reads and writes.
const TICK_OVERHEAD_MINUTES = 30;
const MAX_ASCII_CONTROL_CODE = 31;
const DELETE_CONTROL_CODE = 127;

const cliEntryPath = (): string =>
  fileURLToPath(new URL('cli.ts', import.meta.url));

// systemd parses ExecStart itself rather than through a shell. Quote every
// path as one token, escape its two expansion sigils, and reject control
// characters instead of emitting a unit whose meaning differs from the path.
export const quoteSystemdExecArg = (value: string): string => {
  const hasControlCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= MAX_ASCII_CONTROL_CODE || code === DELETE_CONTROL_CODE;
  });
  if (hasControlCharacter) {
    throw new Error(
      'systemd ExecStart arguments cannot contain control characters',
    );
  }
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('$', '$$$$')
    .replaceAll('%', '%%')}"`;
};

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
ExecStart=${quoteSystemdExecArg(process.execPath)} ${quoteSystemdExecArg(cliEntryPath())} poller --config ${quoteSystemdExecArg(configPath)}
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
