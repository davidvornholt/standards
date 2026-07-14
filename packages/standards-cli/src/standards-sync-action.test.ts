import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const ROOT = join(import.meta.dir, '../../..');
const PACKAGE_ROOT = join(ROOT, 'packages/standards-cli');
const ACTION_DIRECTORY = join(ROOT, '.github/actions/standards-sync-preflight');
const ACTION = join(ACTION_DIRECTORY, 'index.mjs');
const BANNER =
  '// Generated from packages/standards-cli/src/standards-sync-preflight-action.ts and its sync-policy closure; do not edit.';
const EVENT_NAME_VARIABLE = 'GITHUB_EVENT_NAME';
const OUTPUT_VARIABLE = 'GITHUB_OUTPUT';
const WORKSPACE_VARIABLE = 'GITHUB_WORKSPACE';

describe('generated standards sync preflight action', () => {
  it('matches a deterministic explicit-ESM bundle of the typed owner', () => {
    const directory = mkdtempSync(join(tmpdir(), 'standards-action-build-'));
    const output = join(directory, 'index.mjs');
    const metafile = join(directory, 'metafile.json');
    try {
      const result = spawnSync(
        'bun',
        [
          'build',
          'src/standards-sync-preflight-action.ts',
          '--target',
          'node',
          '--format',
          'esm',
          '--packages',
          'bundle',
          '--reject-unresolved',
          '--minify-syntax',
          '--minify-whitespace',
          `--banner=${BANNER}`,
          `--outfile=${output}`,
          `--metafile=${metafile}`,
        ],
        { cwd: PACKAGE_ROOT, encoding: 'utf8' },
      );

      expect(result.status).toBe(0);
      const generated = readFileSync(output, 'utf8');
      expect(generated).toBe(readFileSync(ACTION, 'utf8'));
      expect(generated.startsWith(`${BANNER}\n`)).toBe(true);
      expect(generated).toContain('SYNC_POLICY_CONTRACT_VERSION=1');
      const imports = Array.from(
        generated.matchAll(/\bfrom"(?<specifier>[^"]+)"/gu),
        (match) => match.groups?.specifier,
      );
      expect(imports).toEqual(['node:fs', 'node:path', 'node:process']);
      const metadata = JSON.parse(readFileSync(metafile, 'utf8')) as {
        readonly inputs: Readonly<Record<string, unknown>>;
      };
      expect(Object.keys(metadata.inputs).sort()).toEqual([
        'src/standards-sync-preflight-action.ts',
        'src/sync-policy.ts',
        'src/sync-source.ts',
      ]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('runs from a CommonJS consumer root without a CLI workspace projection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'standards-action-cjs-'));
    const action = join(directory, '.github/actions/standards-sync-preflight');
    const output = join(directory, 'github-output');
    try {
      cpSync(ACTION_DIRECTORY, action, { recursive: true });
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({
          type: 'commonjs',
          devDependencies: { '@davidvornholt/standards': '0.5.0' },
        }),
      );
      const result = spawnSync('node', [join(action, 'index.mjs')], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          [EVENT_NAME_VARIABLE]: 'schedule',
          [OUTPUT_VARIABLE]: output,
          [WORKSPACE_VARIABLE]: directory,
        },
      });

      expect(result.status).toBe(0);
      expect(readFileSync(output, 'utf8')).toBe('run_sync=true\n');
      expect(existsSync(join(directory, 'packages/standards-cli'))).toBe(false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
