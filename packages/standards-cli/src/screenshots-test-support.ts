// Shared harness for the screenshots suites: a consumer with a tracked
// config/screenshots.yaml and an encrypted-shaped SOPS target, a scripted
// `sops` shim on PATH, an in-process S3 stub that records uploads, and a
// cleanup that restores every global it touched.

import { mock } from 'bun:test';
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

const EXECUTABLE_MODE = 0o755;

const originalPath = process.env.PATH;
const roots: Array<string> = [];
const servers: Array<{
  stop: (closeActiveConnections?: boolean) => unknown;
}> = [];

export type RecordedUpload = {
  readonly method: string;
  readonly pathname: string;
  readonly contentType: string | null;
  readonly size: number;
};

export type S3Stub = {
  readonly endpoint: string;
  readonly uploads: ReadonlyArray<RecordedUpload>;
};

const HTTP_OK = 200;

// Bun's S3 client signs real HTTP requests, so the stub is a live server
// rather than a fetch mock.
export const startS3Stub = (status = HTTP_OK): S3Stub => {
  const uploads: Array<RecordedUpload> = [];
  const server = globalThis.Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.arrayBuffer();
      uploads.push({
        method: request.method,
        pathname: new URL(request.url).pathname,
        contentType: request.headers.get('content-type'),
        size: body.byteLength,
      });
      return new Response(status === HTTP_OK ? '' : 'stub failure', {
        status,
      });
    },
  });
  servers.push(server);
  return { endpoint: `http://127.0.0.1:${server.port}`, uploads };
};

export const initializeScreenshotsConsumer = (options: {
  readonly config?: string;
  readonly target?: string;
  readonly sopsJson?: string;
}): string => {
  const root = mkdtempSync(join(tmpdir(), 'screenshots-'));
  roots.push(root);
  const consumer = join(root, 'consumer');
  mkdirSync(join(consumer, 'config'), { recursive: true });
  if (options.config !== undefined) {
    writeFileSync(join(consumer, 'config/screenshots.yaml'), options.config);
  }
  if (options.target !== undefined) {
    mkdirSync(join(consumer, 'secrets'), { recursive: true });
    writeFileSync(
      join(consumer, 'secrets', `${options.target}.yaml`),
      'assets: ENC[AES256_GCM,data:x]\nsops:\n  mac: ENC[AES256_GCM,data:y]\n',
    );
  }
  if (options.sopsJson !== undefined) {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const shim = join(bin, 'sops');
    writeFileSync(shim, `#!/bin/sh\nprintf '%s' '${options.sopsJson}'\n`);
    chmodSync(shim, EXECUTABLE_MODE);
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
  }
  return consumer;
};

export const writeImage = (
  consumer: string,
  name: string,
  bytes: Uint8Array,
): string => {
  const path = join(consumer, name);
  writeFileSync(path, bytes);
  return path;
};

export const cleanupScreenshots = (): void => {
  mock.restore();
  process.env.PATH = originalPath;
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
};
