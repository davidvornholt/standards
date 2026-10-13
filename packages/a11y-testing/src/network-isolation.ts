import { spawnSync } from 'node:child_process';
import process from 'node:process';

// Chromium treats every change of a host network address, such as a renewed
// DHCPv6 address, as a network change and aborts requests in flight, even to
// 127.0.0.1. A private network namespace that holds only a loopback interface
// has no addresses that can change, and its own port space, so a run cannot
// collide with a server on the host either. The namespace's root user maps to
// the calling user, so files and processes keep their host owner. Playwright
// launches Chromium without its sandbox by default, which is what lets the
// browser run as that mapped root user.
const enterNamespace = [
  'unshare',
  '--user',
  '--map-root-user',
  '--net',
  '--',
] as const;
const loopbackUp = ['ip', 'link', 'set', 'lo', 'up'] as const;
// `sh -c` passes the command after the script as "$0" and "$@", so every
// argument reaches the command verbatim, without shell expansion.
const loopbackThenCommand = `${loopbackUp.join(' ')} && exec "$0" "$@"`;
const probeTimeoutMilliseconds = 10_000;

/** The probe builds the namespace a run uses; it disappears when `ip` exits. */
export const isolationProbeCommand: ReadonlyArray<string> = [
  ...enterNamespace,
  ...loopbackUp,
];

export type IsolationProbeResult =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

export type IsolatedCommand = {
  /** The program and its arguments, ready to spawn. */
  readonly command: ReadonlyArray<string>;
  /** Says why the command uses the host network; null when it is isolated. */
  readonly notice: string | null;
};

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';

/** Builds the namespace once and reports whether that worked, and why not. */
export const probeNetworkIsolation = (): IsolationProbeResult => {
  const [program = 'unshare', ...args] = isolationProbeCommand;
  const probe = spawnSync(program, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: probeTimeoutMilliseconds,
  });
  if (probe.error !== undefined) {
    return {
      available: false,
      reason: `${program} could not run: ${probe.error.message}`,
    };
  }
  if (probe.status === 0) {
    return { available: true };
  }
  return {
    available: false,
    reason:
      firstLine(probe.stderr) ||
      `${isolationProbeCommand.join(' ')} exited with ${probe.status ?? probe.signal}`,
  };
};

/**
 * Wraps a command so it runs in a private network namespace with only a
 * loopback interface. Off Linux, or where the probe shows that unprivileged
 * namespaces are unavailable, the command stays unchanged and the notice says
 * why. The probe runs only on Linux.
 */
export const networkIsolatedCommand = (
  command: ReadonlyArray<string>,
  host: {
    readonly platform: NodeJS.Platform;
    readonly probe: () => IsolationProbeResult;
  } = { platform: process.platform, probe: probeNetworkIsolation },
): IsolatedCommand => {
  const probe: IsolationProbeResult =
    host.platform === 'linux'
      ? host.probe()
      : {
          available: false,
          reason: `network namespaces need Linux; this is ${host.platform}`,
        };
  return probe.available
    ? {
        command: [
          ...enterNamespace,
          'sh',
          '-c',
          loopbackThenCommand,
          ...command,
        ],
        notice: null,
      }
    : {
        command,
        notice: `no private network namespace (${probe.reason}); running on the host network`,
      };
};
