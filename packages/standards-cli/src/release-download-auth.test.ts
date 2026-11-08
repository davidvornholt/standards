import { afterEach, expect, it } from 'bun:test';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { cleanupTmpDirs, mkTmp, write } from './cli-test-support';
import { artifact, checksum, scripts } from './release-download-test-support';
import {
  testTlsCertificate,
  testTlsKey,
} from './release-download-tls-test-support';

afterEach(cleanupTmpDirs);

it.each(scripts)(
  '%s keeps API credentials off redirects, files and child environments',
  async (_name, source) => {
    const root = mkTmp('release-auth-');
    const token = 'redirect-fixture-token';
    const received: Array<readonly [string, string | null]> = [];
    const tls = { cert: testTlsCertificate, key: testTlsKey };
    const destination = globalThis.Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      tls,
      fetch(request) {
        received.push(['destination', request.headers.get('authorization')]);
        return new Response(artifact);
      },
    });
    const origin = globalThis.Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      tls,
      fetch(request) {
        if (new URL(request.url).pathname === '/browser') {
          received.push(['browser', request.headers.get('authorization')]);
          return new Response('unavailable', { status: 503 });
        }
        received.push(['api', request.headers.get('authorization')]);
        return Response.redirect(
          `https://localhost:${destination.port}/asset`,
          302,
        );
      },
    });
    try {
      write(root, 'ca.pem', testTlsCertificate);
      write(
        root,
        '.curlrc',
        `location-trusted\ntrace-ascii = "${join(root, 'trace')}"\n`,
      );
      write(root, 'secrets.yaml', 'encrypted fixture');
      write(root, 'bin/uname', '#!/usr/bin/env bash\nprintf x86_64\n');
      chmodSync(join(root, 'bin/uname'), 0o755);
      const script = source
        .replace(/[a-f0-9]{64}/gu, checksum)
        .replaceAll('--retry 3', '--retry 0')
        .replace(
          /https:\/\/github\.com\/[^"\s]+/gu,
          `https://127.0.0.1:${origin.port}/browser`,
        )
        .replace(
          /https:\/\/api\.github\.com\/[^"\s]+/gu,
          `https://127.0.0.1:${origin.port}/api`,
        );
      const child = globalThis.Bun.spawn(
        ['bash', '-x', '-euo', 'pipefail', '-c', script],
        {
          cwd: root,
          env: {
            ...process.env,
            ...Object.fromEntries([
              ['PATH', `${join(root, 'bin')}:${process.env.PATH}`],
              ['RUNNER_TEMP', root],
              ['APP_RELEASE_WORK_DIR', root],
              ['CURL_HOME', root],
              ['CURL_CA_BUNDLE', join(root, 'ca.pem')],
              ['NO_PROXY', '127.0.0.1,localhost'],
              ['no_proxy', '127.0.0.1,localhost'],
              [
                script.includes('install_sops()')
                  ? 'APP_RELEASE_GITHUB_TOKEN'
                  : 'RELEASE_API_TOKEN',
                token,
              ],
              ['EXECUTED', join(root, 'executed')],
              ['SOPS_AGE_KEY', 'fixture'],
              ['SOPS_SECRET_ROOT', 'ci'],
              ['SOPS_SECRET_KEY', 'token'],
              ['SOPS_SECRET_FILE', join(root, 'secrets.yaml')],
              ['GITHUB_OUTPUT', join(root, 'output')],
            ]),
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ status, stderr }).toEqual({
        status: 0,
        stderr: expect.any(String),
      });
      expect(existsSync(join(root, 'executed'))).toBe(true);
      expect(received).toEqual([
        ['browser', null],
        ['api', `Bearer ${token}`],
        ['destination', null],
      ]);
      expect(stdout + stderr).not.toContain(token);
      expect(existsSync(join(root, 'trace'))).toBe(false);
      const output = existsSync(join(root, 'output'))
        ? readFileSync(join(root, 'output'), 'utf8')
        : '';
      expect(output).not.toContain(token);
    } finally {
      await origin.stop(true);
      await destination.stop(true);
    }
  },
);
