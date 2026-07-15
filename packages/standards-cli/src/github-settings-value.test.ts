import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from './github-settings-value';
import { expectedPackedFiles } from './package-listing-test-fixture';

const RECORD_PREDICATE =
  "typeofvalue==='object'&&value!==null&&!Array.isArray(value)";

describe('GitHub settings value contract', () => {
  it('recognizes only non-null, non-array objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ name: 'value' })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('value')).toBe(false);
  });

  it('keeps structural record classification in one GitHub owner', () => {
    const owners = expectedPackedFiles
      .map((path) => path.replace('package/', ''))
      .filter((path) => path.startsWith('src/github-'))
      .filter((path) =>
        readFileSync(join(import.meta.dir, '..', path), 'utf8')
          .replace(/\s/gu, '')
          .includes(RECORD_PREDICATE),
      );

    expect(owners).toEqual(['src/github-settings-value.ts']);
  });
});
