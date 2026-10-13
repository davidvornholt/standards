import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import {
  isolationProbeCommand,
  networkIsolatedCommand,
  probeNetworkIsolation,
} from './network-isolation';

const playwright = ['playwright', 'test', '--grep', 'a b', '$HOME', ';'];
const namespacePrefix = ['unshare', '--user', '--map-root-user', '--net', '--'];
const missingUnshare = /^unshare could not run: /u;
const originalPath = process.env.PATH;
const scratchDirectories: Array<string> = [];

// A directory of stand-in programs, so tests decide what `unshare` and `ip`
// do without creating real namespaces.
const programsDirectory = (programs: Record<string, string>): string => {
  const directory = mkdtempSync(join(tmpdir(), 'a11y-network-isolation-'));
  scratchDirectories.push(directory);
  for (const [name, script] of Object.entries(programs)) {
    const path = join(directory, name);
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
  }
  return directory;
};

afterEach(() => {
  process.env.PATH = originalPath;
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('networkIsolatedCommand', () => {
  it('runs the command in a loopback-only namespace when the Linux probe succeeds', () => {
    const isolated = networkIsolatedCommand(playwright, {
      platform: 'linux',
      probe: () => ({ available: true }),
    });

    expect(isolated).toEqual({
      command: [
        ...namespacePrefix,
        'sh',
        '-c',
        'ip link set lo up && exec "$0" "$@"',
        ...playwright,
      ],
      notice: null,
    });
  });

  it('keeps the command and explains why when the Linux probe fails', () => {
    const isolated = networkIsolatedCommand(playwright, {
      platform: 'linux',
      probe: () => ({
        available: false,
        reason:
          'unshare: write failed /proc/self/uid_map: Operation not permitted',
      }),
    });

    expect(isolated).toEqual({
      command: playwright,
      notice:
        'no private network namespace (unshare: write failed /proc/self/uid_map: Operation not permitted); running on the host network',
    });
  });

  it.each(['darwin', 'win32'] as const)(
    'keeps the command on %s without probing',
    (platform) => {
      let probed = false;
      const isolated = networkIsolatedCommand(playwright, {
        platform,
        probe: () => {
          probed = true;
          return { available: true };
        },
      });

      expect(probed).toBe(false);
      expect(isolated).toEqual({
        command: playwright,
        notice: `no private network namespace (network namespaces need Linux; this is ${platform}); running on the host network`,
      });
    },
  );

  // The namespace itself needs a capable kernel; the shell step inside it
  // does not. Running everything after `unshare ... --` checks that the
  // command receives each argument verbatim, and only once `lo` is up.
  const insideNamespace = (ipScript: string) => {
    const { command } = networkIsolatedCommand(
      ['printf', '%s\n', 'a b', '$HOME', '*', ';', '"quoted"'],
      { platform: 'linux', probe: () => ({ available: true }) },
    );
    const [shell = 'sh', ...shellArgs] = command.slice(namespacePrefix.length);
    process.env.PATH = `${programsDirectory({ ip: ipScript })}:${originalPath}`;
    return spawnSync(shell, shellArgs, { encoding: 'utf8' });
  };

  it('passes every argument verbatim to the command inside the namespace', () => {
    const run = insideNamespace('exit 0');

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('a b\n$HOME\n*\n;\n"quoted"\n');
  });

  it('does not start the command when the loopback interface stays down', () => {
    const run = insideNamespace(
      'echo "RTNETLINK answers: Operation not permitted" >&2; exit 2',
    );

    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
  });
});

describe('probeNetworkIsolation', () => {
  it('probes the namespace a run uses', () => {
    expect(isolationProbeCommand).toEqual([
      ...namespacePrefix,
      'ip',
      'link',
      'set',
      'lo',
      'up',
    ]);
  });

  it('reports isolation as available when the probe succeeds', () => {
    process.env.PATH = programsDirectory({ unshare: 'exit 0' });

    expect(probeNetworkIsolation()).toEqual({ available: true });
  });

  it('reports the first error line when the probe fails', () => {
    process.env.PATH = programsDirectory({
      unshare:
        'echo "unshare: write failed /proc/self/uid_map: Operation not permitted" >&2\necho "second line" >&2\nexit 1',
    });

    expect(probeNetworkIsolation()).toEqual({
      available: false,
      reason:
        'unshare: write failed /proc/self/uid_map: Operation not permitted',
    });
  });

  it('names the exit status when the probe fails silently', () => {
    process.env.PATH = programsDirectory({ unshare: 'exit 1' });

    expect(probeNetworkIsolation()).toEqual({
      available: false,
      reason: `${isolationProbeCommand.join(' ')} exited with 1`,
    });
  });

  it('reports a missing unshare program', () => {
    process.env.PATH = programsDirectory({});

    const probe = probeNetworkIsolation();

    expect(probe.available).toBe(false);
    expect(probe).toMatchObject({
      reason: expect.stringMatching(missingUnshare),
    });
  });
});
