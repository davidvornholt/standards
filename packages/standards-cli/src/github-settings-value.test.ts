import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isPositiveSafeInteger,
  isRecord,
  unknownKeyProblems,
} from './github-settings-value';
import { expectedPackedFiles } from './package-listing-test-fixture';

const RECORD_PREDICATE =
  "typeofvalue==='object'&&value!==null&&!Array.isArray(value)";
const POSITIVE_INTEGER_PREDICATE =
  'Number.isSafeInteger(value)&&Number(value)>0';
const NON_INTEGER = 1.5;
const UNKNOWN_KEY_IMPLEMENTATION =
  /Object\.keys\((?:record|value)\)\.flatMap\(\(key\)\s*=>\s*allowed\.has\(key\)\s*\?\s*\[\]\s*:\s*\[`\$\{prefix\} has unknown key/su;

const githubProductionSources = () =>
  expectedPackedFiles
    .map((path) => path.replace('package/', ''))
    .filter((path) => path.startsWith('src/github-'))
    .map((path) => ({
      path,
      source: readFileSync(join(import.meta.dir, '..', path), 'utf8'),
    }));

describe('GitHub settings value contract', () => {
  it('recognizes only non-null, non-array objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ name: 'value' })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('value')).toBe(false);
  });

  it('recognizes only positive safe integers', () => {
    expect(isPositiveSafeInteger(1)).toBe(true);
    expect(isPositiveSafeInteger(0)).toBe(false);
    expect(isPositiveSafeInteger(-1)).toBe(false);
    expect(isPositiveSafeInteger(NON_INTEGER)).toBe(false);
    expect(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  it('reports every key outside the allowed set', () => {
    expect(
      unknownKeyProblems(
        { accepted: true, firstExtra: false, secondExtra: null },
        new Set(['accepted']),
        'settings',
      ),
    ).toEqual([
      'settings has unknown key "firstExtra"',
      'settings has unknown key "secondExtra"',
    ]);
  });

  it('keeps all generic value primitives in one GitHub owner', () => {
    const sources = githubProductionSources();
    const compactOwners = (predicate: string) =>
      sources
        .filter(({ source }) => source.replace(/\s/gu, '').includes(predicate))
        .map(({ path }) => path);
    const unknownKeyOwners = sources
      .filter(({ source }) => UNKNOWN_KEY_IMPLEMENTATION.test(source))
      .map(({ path }) => path);

    expect(compactOwners(RECORD_PREDICATE)).toEqual([
      'src/github-settings-value.ts',
    ]);
    expect(compactOwners(POSITIVE_INTEGER_PREDICATE)).toEqual([
      'src/github-settings-value.ts',
    ]);
    expect(unknownKeyOwners).toEqual(['src/github-settings-value.ts']);
  });
});
