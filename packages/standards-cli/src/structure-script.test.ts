import { describe, expect, it } from 'bun:test';
import { filteredTurboAliasProblem } from './structure-script';

const filterProblem =
  'package.json: root script "dev" must delegate through Turbo with an explicit --filter';
const syntaxProblem =
  'package.json: root script "dev" contains shell syntax the structure gate does not parse (quotes, |, ;, #, backticks, $(, or &); write a single Turbo command with unquoted arguments';

describe('filteredTurboAliasProblem', () => {
  it('accepts a single filtered turbo run in both --filter forms', () => {
    expect(
      filteredTurboAliasProblem('dev', 'turbo run dev --filter @repo/web'),
    ).toBeNull();
    expect(
      filteredTurboAliasProblem('dev', 'turbo run dev --filter=./apps/*'),
    ).toBeNull();
  });

  it('names the missing filter for parseable non-alias scripts', () => {
    expect(filteredTurboAliasProblem('dev', 'bun run scripts/db.ts')).toBe(
      filterProblem,
    );
    expect(filteredTurboAliasProblem('dev', 'turbo run dev --filter')).toBe(
      filterProblem,
    );
    expect(
      filteredTurboAliasProblem('dev', 'turbo run --help --filter @repo/web'),
    ).toBe(filterProblem);
  });

  it('names the unparseable syntax instead of the filter when quoting is the actual problem', () => {
    expect(
      filteredTurboAliasProblem('dev', "turbo run dev --filter './apps/*'"),
    ).toBe(syntaxProblem);
    expect(
      filteredTurboAliasProblem('dev', 'echo "turbo run dev --filter x"'),
    ).toBe(syntaxProblem);
  });
});
