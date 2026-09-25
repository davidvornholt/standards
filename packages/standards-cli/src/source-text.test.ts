import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { collectSourceTextProblems, inspectSourceText } from './source-text';

const invalidUtf8Byte = 255;
const roots: Array<string> = [];
const repository = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'standards-source-text-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet', root]);
  return root;
};
const track = (
  root: string,
  path: string,
  value: string | Uint8Array,
): void => {
  writeFileSync(join(root, path), value);
  execFileSync('git', ['add', '--', path], { cwd: root });
};
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('tracked source text', () => {
  it('allows escaped controls, tabs, LF, and non-ASCII prose', () => {
    expect(
      inspectSourceText(
        'sample.ts',
        bytes("\tconst key = '\\0';\n// Grüße 日本語\n"),
      ),
    ).toBeNull();
  });

  it.each(['\0', '\r', '\u000b', '\u001b', '\u007f', '\u0085', '\u009f'])(
    'rejects raw control %j without printing source contents',
    (control) => {
      const problem = inspectSourceText(
        'sample.ts',
        bytes(`// first\nprivate content${control}`),
      );
      expect(problem).toContain('"sample.ts":2: raw control character U+');
      expect(problem).not.toContain('private content');
    },
  );

  it('rejects invalid UTF-8', () => {
    expect(
      inspectSourceText('sample.ts', new Uint8Array([invalidUtf8Byte])),
    ).toContain('must be valid UTF-8');
  });

  it.each(['sample.ts', '.envrc', '.env.example', '.gitattributes'])(
    'finds a tracked NUL in %s even when Git classifies it as binary',
    (path) => {
      const root = repository();
      track(root, path, "export const key = 'a\0b';\n");
      expect(collectSourceTextProblems(root)).toEqual([
        `${JSON.stringify(path)}:1: raw control character U+0000; use an escaped representation (only tab and LF are allowed)`,
      ]);
    },
  );

  it('checks working-tree bytes and handles whitespace in tracked filenames', () => {
    const root = repository();
    const path = 'two words\nand a newline.ts';
    track(root, path, 'export {};\n');
    writeFileSync(join(root, path), bytes('// bad\0'));
    expect(collectSourceTextProblems(root)[0]).toContain(
      `${JSON.stringify(path)}:1:`,
    );
  });

  it('ignores binary assets and untracked source', () => {
    const root = repository();
    track(root, 'image.png', new Uint8Array([0, invalidUtf8Byte]));
    track(root, 'valid.ts', 'export {};\n');
    writeFileSync(join(root, 'untracked.ts'), bytes('// bad\0'));
    expect(collectSourceTextProblems(root)).toEqual([]);
  });

  it('rejects a missing tracked source and a symlink without reading its target', () => {
    const root = repository();
    track(root, 'missing.ts', 'export {};\n');
    rmSync(join(root, 'missing.ts'));
    symlinkSync('/outside/private', join(root, 'linked.ts'));
    execFileSync('git', ['add', '--', 'linked.ts'], { cwd: root });
    expect(collectSourceTextProblems(root)).toEqual([
      '"linked.ts": tracked source must be a contained regular file',
      '"missing.ts": tracked source must be a contained regular file',
    ]);
  });

  it('fails closed outside a readable Git tree', () => {
    const root = repository();
    rmSync(join(root, '.git'), { recursive: true });
    expect(collectSourceTextProblems(root)).toEqual([
      'Cannot enumerate tracked source files; run the gate from a readable Git working tree.',
    ]);
  });

  it('exposes a failing CLI exit status for a seeded NUL', () => {
    const root = repository();
    track(root, 'bad.ts', '// bad\0');
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dir, 'cli.ts'), 'source-text', '--dir', root],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('U+0000');
  });
});
