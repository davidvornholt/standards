import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { isContainedPath } from './contained-path';

const sourceExtensions = new Set(
  '.ts,.tsx,.mts,.cts,.js,.jsx,.mjs,.cjs,.json,.jsonc,.yaml,.yml,.toml,.nix,.sh,.bash,.zsh,.rb,.py,.css,.scss,.html,.xml,.svg,.md,.mdx,.sql,.just'.split(
    ',',
  ),
);
const sourceFileNames = new Set([
  'Dockerfile',
  'Containerfile',
  'Makefile',
  'justfile',
  '.envrc',
  '.gitignore',
  '.gitattributes',
  '.dockerignore',
  '.editorconfig',
  '.npmrc',
]);
const dotenvFileName = /^\.env(?:\..*)?$/u;
const forbiddenControl = /[^\P{Cc}\t\n]/u;
const gitOutputLimit = 16_777_216;
const hexadecimalRadix = 16;
const minimumCodePointWidth = 4;

export const inspectSourceText = (
  path: string,
  bytes: Uint8Array,
): string | null => {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return `${JSON.stringify(path)}: source text must be valid UTF-8`;
  }
  const match = forbiddenControl.exec(text);
  if (!match) {
    return null;
  }
  const point = match[0]
    .codePointAt(0)
    ?.toString(hexadecimalRadix)
    .toUpperCase()
    .padStart(minimumCodePointWidth, '0');
  const line = text.slice(0, match.index).split('\n').length;
  return `${JSON.stringify(path)}:${line}: raw control character U+${point}; use an escaped representation (only tab and LF are allowed)`;
};

export const collectSourceTextProblems = (
  root: string,
): ReadonlyArray<string> => {
  let tracked: string;
  try {
    tracked = execFileSync('git', ['ls-files', '--cached', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: gitOutputLimit,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return [
      'Cannot enumerate tracked source files; run the gate from a readable Git working tree.',
    ];
  }
  const problems: Array<string> = [];
  const paths = new Set(
    tracked
      .split('\0')
      .filter(
        (path) =>
          sourceExtensions.has(extname(path)) ||
          sourceFileNames.has(basename(path)) ||
          dotenvFileName.test(basename(path)),
      ),
  );
  for (const path of paths) {
    if (isContainedPath(root, path, 'file')) {
      try {
        const problem = inspectSourceText(path, readFileSync(join(root, path)));
        if (problem !== null) {
          problems.push(problem);
        }
      } catch {
        problems.push(
          `${JSON.stringify(path)}: cannot read tracked source text`,
        );
      }
    } else {
      problems.push(
        `${JSON.stringify(path)}: tracked source must be a contained regular file`,
      );
    }
  }
  return problems;
};
