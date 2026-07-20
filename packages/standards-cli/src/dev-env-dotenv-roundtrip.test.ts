import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';
import { renderDotenv } from './dev-env-dotenv';
import { encodeBunDotenvValue } from './dev-env-dotenv-value';

type CodecCase = readonly [key: string, value: string];

const CASES: ReadonlyArray<CodecCase> = [
  ['EMPTY', ''],
  ['TERMINAL_DOLLAR', '$'],
  ['TEXT_TERMINAL_DOLLAR', 'secret$'],
  ['EXPANSION_TEXT_TERMINAL_DOLLAR', ['$', '{NAME}-$'].join('')],
  ['HASH_TERMINAL_DOLLAR', 'comment#$'],
  ['NEWLINE_TERMINAL_DOLLAR', 'before\nafter$'],
  ['ALL_DELIMITERS_TERMINAL_DOLLAR', `double" single' backtick\`$`],
  ['DOLLAR_NAME', '$NAME'],
  ['BRACED_DOLLAR', ['$', '{NAME:-fallback}'].join('')],
  ['HASH', '# comment-looking'],
  ['LEADING_SPACE', ' leading'],
  ['TRAILING_SPACE', 'trailing '],
  ['TRAILING_TAB', 'trailing\t'],
  ['ALL_DELIMITERS_TRAILING_SPACE', `double" single' backtick\` `],
  ['CARRIAGE_RETURN', 'before\rafter'],
  ['NEWLINE', 'before\nafter'],
  ['BACKSLASH', 'before\\after'],
  ['LITERAL_ESCAPES', String.raw`literal\n and \r`],
  ['TRAILING_BACKSLASH', 'after\\'],
  ['BACKSLASH_NEWLINE', '\\\n'],
  ['UNICODE', 'Grüße 🌍 日本語'],
];

const REJECTED_CASES: ReadonlyArray<CodecCase> = [
  ['BACKSLASH_CARRIAGE_RETURN', '\\\r'],
  ['ALL_DELIMITERS_BACKSLASH_CARRIAGE_RETURN', `"'\`\\\r`],
];

const loadWithBun = (path: string, keys: ReadonlyArray<string>) =>
  spawnSync(
    execPath,
    [
      '--env-file',
      path,
      '-e',
      `const keys=${JSON.stringify(keys)};console.log(JSON.stringify({values:keys.map((key) => Bun.env[key]),unexpected:Object.keys(Bun.env).filter((key) => !keys.includes(key))}))`,
    ],
    { encoding: 'utf8', env: {} },
  );

describe('Bun dotenv value codec', () => {
  it('round-trips every accepted edge case without helper variables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-env-dotenv-roundtrip-'));
    const envFile = join(dir, '.env.local');
    try {
      expect(
        CASES.map(([, value]) => encodeBunDotenvValue(value)),
      ).not.toContain(null);
      writeFileSync(
        envFile,
        renderDotenv('apps.web', 'secrets/dev.yaml', Object.fromEntries(CASES)),
      );

      const loaded = loadWithBun(
        envFile,
        CASES.map(([key]) => key),
      );
      expect(loaded.status).toBe(0);
      expect(JSON.parse(loaded.stdout) as unknown).toEqual({
        values: CASES.map(([, value]) => value),
        unexpected: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects only curated combinations that cannot round-trip', () => {
    expect(
      REJECTED_CASES.map(([key, value]) => [key, encodeBunDotenvValue(value)]),
    ).toEqual(REJECTED_CASES.map(([key]) => [key, null]));
  });
});
