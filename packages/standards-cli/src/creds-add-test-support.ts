// Shared harness for the `creds add cloudflare` suites: a git consumer with
// an encrypted-shaped secrets file, a broker store env override, an optional
// scripted `sops` shim on PATH, Cloudflare envelope builders, and a cleanup
// that restores every global it touched.

import { mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const ACCOUNT_ID_LENGTH = 32;
export const ACCOUNT_A = 'a'.repeat(ACCOUNT_ID_LENGTH);
export const ACCOUNT_B = 'b'.repeat(ACCOUNT_ID_LENGTH);
const EXECUTABLE_MODE = 0o755;

const originalFetch = globalThis.fetch;
const originalBroker = process.env.STANDARDS_BROKER_FILE;
const originalPath = process.env.PATH;
let root = '';

export const response = (result: unknown, info?: unknown): Response =>
  Response.json({
    success: true,
    errors: [],
    result,
    // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
    ...(info === undefined ? {} : { result_info: info }),
  });

export const pageInfo = (count: number, totalCount: number): unknown => ({
  page: 1,
  // biome-ignore lint/style/useNamingConvention: Cloudflare's pagination field is snake_case.
  per_page: 50,
  count,
  // biome-ignore lint/style/useNamingConvention: Cloudflare's pagination field is snake_case.
  total_count: totalCount,
});

export const initializeConsumer = (
  accounts: ReadonlyArray<string>,
  secrets = 'ci:\n  token: ENC[AES256_GCM,data:x]\nsops:\n  mac: ENC[AES256_GCM,data:y]\n  version: 3.9.4\n',
): string => {
  root = mkdtempSync(join(tmpdir(), 'creds-add-'));
  const consumer = join(root, 'consumer');
  mkdirSync(join(consumer, 'secrets'), { recursive: true });
  writeFileSync(join(consumer, 'secrets', 'ci.yaml'), secrets);
  execFileSync('git', ['init', '-q', consumer]);
  execFileSync('git', [
    '-C',
    consumer,
    'remote',
    'add',
    'origin',
    'git@github.com:davidvornholt/example.git',
  ]);
  const broker = join(root, 'broker.yaml');
  writeFileSync(
    broker,
    `cloudflare:\n${accounts.map((account) => `  - account_id: ${account}\n    token: bootstrap-${account}`).join('\n')}\n`,
  );
  process.env.STANDARDS_BROKER_FILE = broker;
  return consumer;
};

export const installSops = (body: string): void => {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const path = join(bin, 'sops');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, EXECUTABLE_MODE);
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
};

export const cleanupCredsAdd = (): void => {
  mock.restore();
  globalThis.fetch = originalFetch;
  if (originalBroker === undefined) {
    delete process.env.STANDARDS_BROKER_FILE;
  } else {
    process.env.STANDARDS_BROKER_FILE = originalBroker;
  }
  process.env.PATH = originalPath;
  if (root.length > 0) {
    rmSync(root, { recursive: true, force: true });
    root = '';
  }
};
