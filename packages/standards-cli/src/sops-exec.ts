// Shared sops process runner: prefer a local sops binary and fall back to
// `nix run nixpkgs#sops`, mirroring the canonical secrets.just tool
// resolution. Used by dev-env decryption and the creds SOPS writers.

import { spawnSync } from 'node:child_process';
import process from 'node:process';

export type SopsRunResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorMessage: string | null;
};

export const runSops = (
  args: ReadonlyArray<string>,
  cwd: string,
  env?: Readonly<Record<string, string>>,
): SopsRunResult => {
  const options = {
    cwd,
    encoding: 'utf8' as const,
    env: { ...process.env, ...(env ?? {}) },
  };
  const localSops = spawnSync('sops', [...args], options);
  const result =
    localSops.error === undefined && localSops.status !== null
      ? localSops
      : spawnSync(
          'nix',
          [
            '--extra-experimental-features',
            'nix-command flakes',
            'run',
            'nixpkgs#sops',
            '--',
            ...args,
          ],
          options,
        );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    errorMessage: result.error?.message ?? null,
  };
};
