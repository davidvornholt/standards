// `standards screenshots publish` uploads UI screenshots to the configured
// public bucket at content-addressed keys and prints the markdown that embeds
// them in a pull request description. Validation gathers every config and
// file problem before any upload starts, and the resolved credential pair is
// used in memory only, never printed.

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import {
  loadScreenshotsConfig,
  type ScreenshotsConfig,
} from './screenshots-config';
import { resolveScreenshotsPair } from './screenshots-pair';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

// The basename becomes a URL path segment, so it must stay portable as-is:
// no separators, spaces, or characters that need percent-encoding.
const SAFE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

const KEY_PREFIX = 'screenshots';

const readImageFile = (file: string): Uint8Array => {
  const path = resolve(file);
  const link = lstatSync(path);
  if (link.isSymbolicLink() || !link.isFile() || realpathSync(path) !== path) {
    throw new Error('not a regular file');
  }
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY + constants.O_NOFOLLOW);
    if (!fstatSync(descriptor).isFile()) {
      throw new Error('not a regular file');
    }
    return readFileSync(descriptor);
  } finally {
    if (descriptor !== null) {
      closeSync(descriptor);
    }
  }
};

const fileProblems = (file: string): ReadonlyArray<string> => {
  const name = basename(file);
  const problems: Array<string> = [];
  let size: number | null = null;
  try {
    size = readImageFile(file).byteLength;
  } catch {
    size = null;
  }
  if (size === null) {
    problems.push(`${file} is not a readable file`);
  } else if (size === 0) {
    problems.push(`${file} is empty`);
  }
  if (CONTENT_TYPES[extname(name).toLowerCase()] === undefined) {
    problems.push(
      `${file} has an unsupported extension; supported: ${Object.keys(CONTENT_TYPES).join(', ')}`,
    );
  }
  if (!SAFE_BASENAME.test(name)) {
    problems.push(
      `${file} has a name unsafe for URLs; rename it to letters, digits, ".", "_", and "-"`,
    );
  }
  return problems;
};

const publishOne = async (
  client: Bun.S3Client,
  config: ScreenshotsConfig,
  file: string,
): Promise<string> => {
  const bytes = readImageFile(file);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const name = basename(file);
  const key = `${KEY_PREFIX}/${digest}/${name}`;
  await client.write(key, bytes, {
    type: CONTENT_TYPES[extname(name).toLowerCase()],
  });
  const alt = name.slice(0, name.length - extname(name).length);
  const objectUrl = new URL(key, `${config.publicBaseUrl}/`).href;
  return `![${alt}](<${objectUrl}>)`;
};

export const runScreenshotsPublish = async (
  dir: string,
  files: ReadonlyArray<string>,
): Promise<boolean> => {
  if (files.length === 0) {
    console.error(
      'standards screenshots: publish requires at least one image file',
    );
    return false;
  }
  const config = loadScreenshotsConfig(dir);
  const problems = [
    ...(config.ok ? [] : config.problems),
    ...files.flatMap(fileProblems),
  ];
  if (problems.length > 0 || !config.ok) {
    console.error(
      `standards screenshots: ${problems.length} problem(s):\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
    );
    return false;
  }
  const pair = resolveScreenshotsPair(
    dir,
    config.value.pair,
    config.value.bucket,
  );
  if (!pair.ok) {
    console.error(`standards screenshots: ${pair.problem}`);
    return false;
  }
  const client = new globalThis.Bun.S3Client({
    accessKeyId: pair.accessKeyId,
    secretAccessKey: pair.secretAccessKey,
    bucket: config.value.bucket,
    endpoint: config.value.endpoint,
  });
  try {
    const lines = await Promise.all(
      files.map((file) => publishOne(client, config.value, file)),
    );
    for (const line of lines) {
      console.log(line);
    }
    return true;
  } catch (error) {
    console.error(
      `standards screenshots: upload failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
};
