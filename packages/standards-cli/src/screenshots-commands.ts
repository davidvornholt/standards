// The screenshots command family: publish UI screenshots to the repository's
// configured public bucket and print the markdown that embeds them in a pull
// request description. Configuration lives in the tracked
// config/screenshots.yaml; the signing credential stays in its SOPS target.

import { resolve } from 'node:path';
import process from 'node:process';
import { SCREENSHOTS_CONFIG_FILE } from './screenshots-config';
import { runScreenshotsPublish } from './screenshots-publish';

const SCREENSHOTS_USAGE = `Usage: standards screenshots <command> [options]

Commands:
  publish <files...>  Upload screenshots to the configured public bucket at content-addressed keys and print one markdown image line per file

Options:
  --dir <path>  Repository holding ${SCREENSHOTS_CONFIG_FILE} and the SOPS credential target (default: current directory)

Publishing reads ${SCREENSHOTS_CONFIG_FILE} (pair, bucket, endpoint, publicBaseUrl) and resolves the credential pair from its SOPS target at publish time. Published URLs are public to anyone holding the link and are kept indefinitely so pull request history keeps rendering.`;

type ScreenshotsFlags = {
  dir: string;
  readonly words: Array<string>;
};

const parseScreenshotsArgs = (
  argv: ReadonlyArray<string>,
): ScreenshotsFlags => {
  const flags: ScreenshotsFlags = { dir: process.cwd(), words: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--dir') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      flags.dir = value;
      index += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown screenshots option: ${arg}`);
    } else {
      flags.words.push(arg);
    }
  }
  flags.dir = resolve(flags.dir);
  return flags;
};

export const runScreenshotsCommand = (
  argv: ReadonlyArray<string>,
): Promise<boolean> => {
  const flags = parseScreenshotsArgs(argv);
  const [route, ...files] = flags.words;
  if (route === undefined || route === 'help') {
    console.log(SCREENSHOTS_USAGE);
    return Promise.resolve(route === 'help');
  }
  if (route === 'publish') {
    return runScreenshotsPublish(flags.dir, files);
  }
  console.error(`standards screenshots: unknown command: ${route}\n`);
  console.error(SCREENSHOTS_USAGE);
  return Promise.resolve(false);
};
