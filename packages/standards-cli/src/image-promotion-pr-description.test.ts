import { afterEach, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { cleanupTmpDirs, mkTmp, runProcess } from './cli-test-support';
import {
  contract,
  environment,
} from './image-promotion-reference-contract-test-support';

afterEach(cleanupTmpDirs);

it.each([false, true])('describes operational effects for live=%s', (live) => {
  const fixture = mkTmp('promotion-body-');
  const body = join(fixture, 'body.md');
  const result = runProcess(
    'bash',
    fixture,
    ['-c', contract('promotion-pr-body', 'sh')],
    environment([
      ['PATH', process.env.PATH],
      ['APP_NAME', 'web'],
      [
        'BASE_APP_JSON',
        JSON.stringify({
          promotionEnabled: live,
          digest: live ? 'sha256:abc' : null,
          promotedSourceSha: live ? 'abc' : null,
        }),
      ],
      ['PR_BODY_FILE', body],
    ]),
  );
  expect(result.status).toBe(0);
  const description = readFileSync(body, 'utf8');
  for (const phrase of [
    'First production deployment',
    'database migrations',
    'production service',
    'public endpoint',
    'registry-access prerequisites',
  ]) {
    expect(description.includes(phrase)).toBe(!live);
  }
});
