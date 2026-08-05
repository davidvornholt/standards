import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  filteredTurboAliasProblem,
  isSafeFilteredTurboAlias,
} from './structure-script';

const problem = (detail: string): string =>
  `package.json: root script "dev" ${detail}`;
const EXECUTABLE_MODE = 0o755;
const NON_EXECUTING_PROBLEM =
  'must execute a task; Turbo help, version, and dry-run options are not allowed';

describe('filteredTurboAliasProblem', () => {
  it.each([
    'turbo run dev --filter @repo/web',
    'turbo run dev --filter=./apps/*',
  ])('accepts a single filtered Turbo run: %s', (script) => {
    expect(filteredTurboAliasProblem('dev', script)).toBeNull();
    expect(isSafeFilteredTurboAlias(script)).toBeTrue();
  });

  it.each([
    ['', 'must be a non-empty single filtered Turbo command'],
    ['   ', 'must be a non-empty single filtered Turbo command'],
    ['bun run scripts/db.ts', 'must invoke Turbo directly with "turbo"'],
    ['turbo dev --filter @repo/web', 'must invoke Turbo through "turbo run"'],
    [
      'turbo run --cache --filter @repo/web',
      'must put a task name immediately after "turbo run"',
    ],
    ['turbo run', 'must put a task name immediately after "turbo run"'],
    ['turbo run dev -h --filter @repo/web', NON_EXECUTING_PROBLEM],
    ['turbo run dev -v --filter @repo/web', NON_EXECUTING_PROBLEM],
    ['turbo run dev --dry --filter @repo/web', NON_EXECUTING_PROBLEM],
    ['turbo run dev --help --filter @repo/web', NON_EXECUTING_PROBLEM],
    ['turbo run dev --version --filter @repo/web', NON_EXECUTING_PROBLEM],
    ['turbo run dev -h=value --filter @repo/web', NON_EXECUTING_PROBLEM],
    ['turbo run dev -v=value --filter @repo/web', NON_EXECUTING_PROBLEM],
    ['turbo run dev --dry=value --filter @repo/web', NON_EXECUTING_PROBLEM],
    ['turbo run dev --help=value --filter @repo/web', NON_EXECUTING_PROBLEM],
    ['turbo run dev --version=value --filter @repo/web', NON_EXECUTING_PROBLEM],
    ['turbo run dev', 'must pass an explicit --filter'],
    ['turbo run dev --filter', 'must pass a non-empty value to --filter'],
    ['turbo run dev --filter=', 'must pass a non-empty value to --filter'],
    [
      'turbo run dev --filter --cache',
      'must pass a --filter value that is not another option',
    ],
    [
      'turbo run dev --filter=-cache',
      'must pass a --filter value that is not another option',
    ],
  ])('names the failed alias contract for %j', (script, detail) => {
    expect(filteredTurboAliasProblem('dev', script)).toBe(problem(detail));
    expect(isSafeFilteredTurboAlias(script)).toBeFalse();
  });

  const syntaxProblem = problem(
    'contains shell syntax the structure gate does not parse (quotes, |, ;, #, backticks, $(, CR/LF line breaks, or malformed ampersand separators); write one command with plain arguments, using --filter=./apps/* for a glob',
  );
  it.each([
    "turbo run dev --filter './apps/*'",
    'echo "turbo run dev --filter x"',
    'turbo run dev --filter x | cat',
    'turbo run dev --filter x; echo done',
    'turbo run dev --filter x # comment',
    'turbo run dev --filter `pwd`',
    'turbo run dev --filter $(pwd)',
    'turbo run dev --filter x\r',
    'turbo run dev --filter x\n',
    'turbo run dev --filter x &',
    'turbo run dev --filter x &&& echo done',
    '&& turbo run dev --filter @repo/web',
    'turbo run dev --filter @repo/web &&',
    'turbo run dev --filter @repo/web && && turbo run lint --filter @repo/web',
  ])('names every parser-rejected syntax family for %j', (script) => {
    expect(filteredTurboAliasProblem('dev', script)).toBe(syntaxProblem);
    expect(isSafeFilteredTurboAlias(script)).toBeFalse();
  });

  it('names a parsed command chain instead of claiming its filters are missing', () => {
    const script =
      'turbo run dev --filter @repo/web && turbo run lint --filter @repo/web';
    expect(filteredTurboAliasProblem('dev', script)).toBe(
      problem(
        'must contain exactly one command; && command chains are not supported',
      ),
    );
    expect(isSafeFilteredTurboAlias(script)).toBeFalse();
  });
});

describe('filtered Turbo glob guidance', () => {
  it('keeps the suggested glob filter in one argv value through a Bun package script', () => {
    const consumer = mkdtempSync(join(tmpdir(), 'structure-script-'));
    try {
      const turbo = join(consumer, 'node_modules/.bin/turbo');
      mkdirSync(join(consumer, 'apps/api'), { recursive: true });
      mkdirSync(join(consumer, 'apps/web'), { recursive: true });
      mkdirSync(join(consumer, 'node_modules/.bin'), { recursive: true });
      writeFileSync(
        join(consumer, 'package.json'),
        JSON.stringify({
          scripts: { probe: 'turbo run dev --filter=./apps/*' },
        }),
      );
      writeFileSync(
        turbo,
        '#!/usr/bin/env bun\nconsole.log(JSON.stringify(process.argv.slice(2)));\n',
      );
      chmodSync(turbo, EXECUTABLE_MODE);

      const result = spawnSync('bun', ['run', 'probe'], {
        cwd: consumer,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('["run","dev","--filter=./apps/*"]');
      expect(
        filteredTurboAliasProblem('dev', 'turbo run dev --filter=./apps/*'),
      ).toBeNull();
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });
});
