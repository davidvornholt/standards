// The tracked config/screenshots.yaml is a repository's contract for
// `standards screenshots publish`: which brokered S3 pair signs uploads,
// which bucket and endpoint receive them, and which public base URL serves
// the published objects. Every value here is configuration; the credential
// pair stays in its SOPS target and is resolved only at publish time.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CredsDestination, parseDestination } from './creds-dest';
import { isR2BucketName } from './creds-r2';
import { isRecord } from './github-settings-parse';
import { parseYaml } from './yaml-parse';

export const SCREENSHOTS_CONFIG_FILE = 'config/screenshots.yaml';

const FIELDS = ['pair', 'bucket', 'endpoint', 'publicBaseUrl'] as const;

export type ScreenshotsConfig = {
  readonly pair: CredsDestination;
  readonly bucket: string;
  readonly endpoint: string;
  readonly publicBaseUrl: string;
};

export type ScreenshotsConfigResult =
  | { readonly ok: true; readonly value: ScreenshotsConfig }
  | { readonly ok: false; readonly problems: ReadonlyArray<string> };

type RawScreenshotsConfigResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly problems: ReadonlyArray<string> };

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};

const stripTrailingSlash = (value: string): string =>
  value.endsWith('/') ? value.slice(0, -1) : value;

const readScreenshotsConfig = (
  consumer: string,
): RawScreenshotsConfigResult => {
  const path = join(consumer, SCREENSHOTS_CONFIG_FILE);
  if (!existsSync(path)) {
    return {
      ok: false,
      problems: [
        `${SCREENSHOTS_CONFIG_FILE} not found; screenshot publishing is not enabled for this repository`,
      ],
    };
  }
  try {
    return { ok: true, value: readFileSync(path, 'utf8') };
  } catch (error) {
    return {
      ok: false,
      problems: [
        `could not read ${SCREENSHOTS_CONFIG_FILE}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }
};

export const loadScreenshotsConfig = (
  consumer: string,
): ScreenshotsConfigResult => {
  const raw = readScreenshotsConfig(consumer);
  if (!raw.ok) {
    return raw;
  }
  const parsed = parseYaml(raw.value, SCREENSHOTS_CONFIG_FILE);
  if (parsed.problem !== null) {
    return { ok: false, problems: [parsed.problem] };
  }
  if (!isRecord(parsed.value)) {
    return {
      ok: false,
      problems: [
        `${SCREENSHOTS_CONFIG_FILE} must be a mapping with ${FIELDS.join(', ')}`,
      ],
    };
  }
  const record = parsed.value;
  const problems: Array<string> = [];
  for (const key of Object.keys(record)) {
    if (!(FIELDS as ReadonlyArray<string>).includes(key)) {
      problems.push(`${SCREENSHOTS_CONFIG_FILE} has an unknown key "${key}"`);
    }
  }
  const stringField = (field: (typeof FIELDS)[number]): string | null => {
    const value = record[field];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
    problems.push(
      `${SCREENSHOTS_CONFIG_FILE} ${field} must be a non-empty string`,
    );
    return null;
  };
  const pairRaw = stringField('pair');
  const pair = pairRaw === null ? null : parseDestination(pairRaw);
  if (pairRaw !== null && pair === null) {
    problems.push(
      `${SCREENSHOTS_CONFIG_FILE} pair must be "<target>:<dotted.key>", e.g. assets:assets.screenshots_rw`,
    );
  }
  const bucket = stringField('bucket');
  if (bucket !== null && !isR2BucketName(bucket)) {
    problems.push(
      `${SCREENSHOTS_CONFIG_FILE} bucket "${bucket}" is not a valid bucket name`,
    );
  }
  const urlField = (field: 'endpoint' | 'publicBaseUrl'): string | null => {
    const value = stringField(field);
    if (value !== null && !isHttpUrl(value)) {
      problems.push(
        `${SCREENSHOTS_CONFIG_FILE} ${field} must be an http(s) URL`,
      );
      return null;
    }
    return value === null ? null : stripTrailingSlash(value);
  };
  const endpoint = urlField('endpoint');
  const publicBaseUrl = urlField('publicBaseUrl');
  return problems.length === 0 &&
    pair !== null &&
    bucket !== null &&
    endpoint !== null &&
    publicBaseUrl !== null
    ? { ok: true, value: { pair, bucket, endpoint, publicBaseUrl } }
    : { ok: false, problems };
};
