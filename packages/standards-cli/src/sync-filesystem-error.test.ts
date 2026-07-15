import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMissingFilesystemError } from './sync-filesystem-error';

describe('filesystem error classification', () => {
  it('recognizes only structural missing-path errors', () => {
    expect(isMissingFilesystemError({ code: 'ENOENT' })).toBe(true);
    expect(isMissingFilesystemError({ code: 'EEXIST' })).toBe(false);
    expect(isMissingFilesystemError({ code: 'ESRCH' })).toBe(false);
    expect(isMissingFilesystemError({ code: 2 })).toBe(false);
    expect(isMissingFilesystemError(null)).toBe(false);
    expect(isMissingFilesystemError('ENOENT')).toBe(false);
  });

  it('keeps the ENOENT contract in one production owner', () => {
    const owners = readdirSync(import.meta.dir)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .filter((name) =>
        readFileSync(join(import.meta.dir, name), 'utf8').includes("'ENOENT'"),
      );

    expect(owners).toEqual(['sync-filesystem-error.ts']);
  });
});
