// CLI wiring for the poller command family. A tick is a gate-style command:
// it reports what it did and fails loudly when any repository could not be
// processed, so a red systemd unit is the durable signal that jobs stalled.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { resolveToken } from './github-api';
import { type PollerConfig, parsePollerConfig } from './poller-config';
import { runPollerInstall, runPollerPrintUnits } from './poller-install';
import { runPollerTick } from './poller-tick';

export type PollerCommandOptions = {
  readonly configPath: string | undefined;
  readonly install: boolean;
  readonly printUnits: boolean;
};

const loadConfig = async (configPath: string): Promise<PollerConfig> => {
  const path = resolve(configPath);
  if (!existsSync(path)) {
    throw new Error(`poller config not found: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`poller config must contain valid JSON: ${path}`, {
      cause: error,
    });
  }
  const { config, problems } = parsePollerConfig(parsed, dirname(path));
  if (config === null) {
    throw new Error(
      [
        `invalid poller config ${path}:`,
        ...problems.map((p) => `  - ${p}`),
      ].join('\n'),
    );
  }
  return config;
};

export const runPollerCommand = async (
  options: PollerCommandOptions,
): Promise<boolean> => {
  if (options.configPath === undefined) {
    console.error('standards poller: --config <path> is required');
    return false;
  }
  if (options.printUnits) {
    runPollerPrintUnits(options.configPath);
    return true;
  }
  // Validate the config before install so a broken file fails now, not on
  // the first timer firing at 3am.
  const config = await loadConfig(options.configPath);
  if (options.install) {
    await runPollerInstall(options.configPath);
    return true;
  }
  const token = resolveToken();
  if (token === null) {
    console.error(
      'standards poller: no GitHub token (GH_TOKEN, GITHUB_TOKEN, or gh auth); the poller cannot label, push, or open PRs anonymously',
    );
    return false;
  }
  const { lines, problems } = await runPollerTick(config, token, Date.now());
  for (const line of lines) {
    console.log(`  ${line}`);
  }
  if (problems.length > 0) {
    console.error(`standards poller: ${problems.length} problem(s):`);
    console.error(problems.map((problem) => `  - ${problem}`).join('\n'));
    return false;
  }
  console.log(
    `standards poller: tick complete (${lines.length} event(s) across ${config.repos.length} repo(s))`,
  );
  return true;
};
