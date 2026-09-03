import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';
import { renderDotenv } from './dev-env-dotenv';
import { encodePortableDotenvValue } from './dev-env-dotenv-value';

type CodecCase = readonly [key: string, value: string];

const CASES: ReadonlyArray<CodecCase> = [
  ['EMPTY', ''],
  ['HASH', '# comment-looking'],
  ['LEADING_SPACE', ' leading'],
  ['TRAILING_SPACE', 'trailing '],
  ['TRAILING_TAB', 'trailing\t'],
  ['ALL_DELIMITERS', `double" single' backtick\``],
  ['NEWLINE', 'before\nafter'],
  ['BACKSLASH', 'before\\after'],
  ['LITERAL_ESCAPES', String.raw`literal\n and \r`],
  ['TRAILING_BACKSLASH', 'after\\'],
  ['BACKSLASH_NEWLINE', '\\\n'],
  ['UNICODE', 'Grüße 🌍 日本語'],
];

const REJECTED_CASES: ReadonlyArray<CodecCase> = [
  ['TERMINAL_DOLLAR', '$'],
  ['DOLLAR_NAME', '$NAME'],
  ['BRACED_DOLLAR', ['$', '{NAME:-fallback}'].join('')],
  ['CARRIAGE_RETURN', 'before\rafter'],
  ['NULL_BYTE', 'before\0after'],
  ['ALL_DELIMITERS_TRAILING_SPACE', `double" single' backtick\` `],
  ['ALL_DELIMITERS_HASH', `double" single' backtick\` #`],
  ['HASH_TRAILING_BACKSLASH', '#\\'],
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
      `const keys=${JSON.stringify(keys)};const runtimeKeys=new Set(['LD_LIBRARY_PATH']);console.log(JSON.stringify({values:keys.map((key) => Bun.env[key]),unexpected:Object.keys(Bun.env).filter((key) => !keys.includes(key)&&!runtimeKeys.has(key))}))`,
    ],
    { encoding: 'utf8', env: {} },
  );

const loadWithNode = (path: string, keys: ReadonlyArray<string>) =>
  spawnSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `import { readFileSync } from 'node:fs';import { parseEnv } from 'node:util';const keys=${JSON.stringify(keys)};const parsed=parseEnv(readFileSync(process.argv[1],'utf8'));console.log(JSON.stringify({values:keys.map((key) => parsed[key]),unexpected:Object.keys(parsed).filter((key) => !keys.includes(key))}))`,
      path,
    ],
    { encoding: 'utf8' },
  );

describe('portable dotenv value codec', () => {
  it('round-trips every accepted edge case through Bun and Node', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-env-dotenv-roundtrip-'));
    const envFile = join(dir, '.env.local');
    try {
      expect(
        CASES.map(([, value]) => encodePortableDotenvValue(value)),
      ).not.toContain(null);
      writeFileSync(
        envFile,
        renderDotenv(
          'apps.web',
          ['secrets/dev.yaml'],
          Object.fromEntries(CASES),
        ),
      );

      const keys = CASES.map(([key]) => key);
      const expected = {
        values: CASES.map(([, value]) => value),
        unexpected: [],
      };
      for (const loaded of [
        loadWithBun(envFile, keys),
        loadWithNode(envFile, keys),
      ]) {
        expect(loaded.status).toBe(0);
        expect(JSON.parse(loaded.stdout) as unknown).toEqual(expected);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects only curated combinations that cannot round-trip', () => {
    expect(
      REJECTED_CASES.map(([key, value]) => [
        key,
        encodePortableDotenvValue(value),
      ]),
    ).toEqual(REJECTED_CASES.map(([key]) => [key, null]));
  });
});
