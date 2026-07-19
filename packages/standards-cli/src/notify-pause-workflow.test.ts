import { afterEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  ACTUAL_UPSTREAM,
  cleanupTmpDirs,
  mkTmp,
  runProcess,
  write,
  yamlRunScript,
} from './cli-test-support';

const NOTIFY_WORKFLOW = join(
  ACTUAL_UPSTREAM,
  '.github/workflows/notify-pause.yml',
);
const WAIT_ATTEMPTS = 100;
const WAIT_INTERVAL_MS = 20;
const WAIT_BUFFER_BYTES = 4;
const WAIT_INDEX = 0;
const WAIT_EXPECTED = 0;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(WAIT_BUFFER_BYTES));
const BODY_PATH_ENV = 'BODY_PATH';
const PORT_PATH_ENV = 'PORT_PATH';
const NTFY_TOPIC_URL_ENV = 'NTFY_TOPIC_URL';
const PAUSE_NUMBER_ENV = 'PAUSE_NUMBER';
const PAUSE_TITLE_ENV = 'PAUSE_TITLE';
const PAUSE_URL_ENV = 'PAUSE_URL';
const REPO_ENV = 'REPO';

afterEach(cleanupTmpDirs);

const waitForNonEmptyFile = (path: string): string => {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf8');
      if (content.length > 0) {
        return content;
      }
    }
    Atomics.wait(WAIT_BUFFER, WAIT_INDEX, WAIT_EXPECTED, WAIT_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${path}`);
};

const sendNotification = (
  title: string,
): { readonly body: string; readonly status: number } => {
  const fixture = mkTmp('notify-loopback-');
  const bodyPath = join(fixture, 'body');
  const portPath = join(fixture, 'port');
  const serverPath = join(fixture, 'server.ts');
  write(
    fixture,
    'server.ts',
    [
      "const bodyPath = process.env.BODY_PATH ?? '';",
      "const portPath = process.env.PORT_PATH ?? '';",
      'const server = Bun.serve({',
      "  hostname: '127.0.0.1',",
      '  port: 0,',
      '  async fetch(request) {',
      '    await Bun.write(bodyPath, await request.arrayBuffer());',
      '    setTimeout(() => server.stop(), 50);',
      '    return new Response(null, { status: 204 });',
      '  },',
      '});',
      'await Bun.write(portPath, String(server.port));',
      '',
    ].join('\n'),
  );
  const server = spawn('bun', [serverPath], {
    cwd: fixture,
    env: {
      ...process.env,
      [BODY_PATH_ENV]: bodyPath,
      [PORT_PATH_ENV]: portPath,
    },
  });

  try {
    const port = waitForNonEmptyFile(portPath);
    const result = runProcess(
      'bash',
      fixture,
      [
        '-euo',
        'pipefail',
        '-c',
        yamlRunScript(NOTIFY_WORKFLOW, 'Push a notification'),
      ],
      {
        ...process.env,
        [NTFY_TOPIC_URL_ENV]: `http://127.0.0.1:${port}`,
        [PAUSE_NUMBER_ENV]: '102',
        [PAUSE_TITLE_ENV]: title,
        [PAUSE_URL_ENV]: 'https://example.test/pull/102',
        [REPO_ENV]: 'owner/repo',
      },
    );
    return { body: waitForNonEmptyFile(bodyPath), status: result.status };
  } finally {
    server.kill();
  }
};

describe('notify-pause workflow request body', () => {
  it.each([
    'Routine pause',
    '@/proc/self/environ',
  ])('sends %s byte-for-byte', (title) => {
    const result = sendNotification(title);

    expect(result.status).toBe(0);
    expect(result.body).toBe(title);
  });
});
