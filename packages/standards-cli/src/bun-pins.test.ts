import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { raiseBunPins } from './bun-pins';
import { compareVersions } from './bun-version';
import { cleanupTmpDirs, mkTmp, write } from './cli-test-support';

const OLD_DIGEST = `sha256:${'1'.repeat(64)}`;
const digestFor = (tag: string): string =>
  `sha256:${tag.replaceAll(/\D/gu, '').padEnd(64, 'a')}`;

type Files = ReadonlyArray<readonly [string, string]>;

const repo = (files: Files): string => {
  const dir = mkTmp('bun-pins-');
  execFileSync('git', ['init', '--quiet', dir]);
  for (const [path, content] of files) {
    write(dir, path, content);
  }
  execFileSync('git', ['add', '--all'], { cwd: dir });
  return dir;
};

const read = (dir: string, path: string): string =>
  readFileSync(join(dir, path), 'utf8');

const resolved: Array<string> = [];
const resolveDigest = (tag: string): Promise<string> => {
  resolved.push(tag);
  return Promise.resolve(digestFor(tag));
};

const raise = (
  dir: string,
  exclude: ReadonlyArray<string> = [],
  resolver: typeof resolveDigest | null = resolveDigest,
) =>
  raiseBunPins({
    dir,
    target: '1.4.5',
    exclude: new Set(exclude),
    resolveDigest: resolver,
  });

afterEach(() => {
  cleanupTmpDirs();
  resolved.length = 0;
});

const ROOT_MANIFEST = `${JSON.stringify(
  {
    packageManager: 'bun@1.4.3',
    engines: { bun: '>=1.4.3' },
    devDependencies: { bun: '1.0.0' },
  },
  null,
  2,
)}\n`;

const EVERY_KIND: Files = [
  ['package.json', ROOT_MANIFEST],
  ['apps/web/package.json', '{ "packageManager": "bun@1.3.9" }\n'],
  [
    'Dockerfile',
    `ARG BUN_VERSION=1.4.3\nFROM oven/bun:1.4.3-slim@${OLD_DIGEST} AS build\nFROM docker.io/oven/bun:1.4.3-alpine\n`,
  ],
  ['apps/api/Dockerfile.prod', 'FROM mirror.gcr.io/oven/bun:1.4.3\n'],
  [
    '.github/workflows/ci.yml',
    'jobs:\n  test:\n    steps:\n      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: "1.4.3"\n    env:\n      BUN_VERSION: 1.4.3\n',
  ],
  ['.bun-version', '1.4.3\n'],
  ['.tool-versions', 'nodejs 24.0.0\nbun 1.4.3\n'],
];

describe('raiseBunPins across pin kinds', () => {
  it('reports every file whose Bun pins are below the target', async () => {
    const result = await raise(repo(EVERY_KIND));

    expect(result?.raised).toEqual([
      { path: '.bun-version', from: ['1.4.3'] },
      { path: '.github/workflows/ci.yml', from: ['1.4.3'] },
      { path: '.tool-versions', from: ['1.4.3'] },
      { path: 'Dockerfile', from: ['1.4.3'] },
      { path: 'apps/api/Dockerfile.prod', from: ['1.4.3'] },
      { path: 'apps/web/package.json', from: ['1.3.9'] },
      { path: 'package.json', from: ['1.4.3'] },
    ]);
    // Every Docker Hub tag it moves to is checked, pinned by digest or not.
    expect(
      resolved.toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(['1.4.5', '1.4.5-alpine', '1.4.5-slim']);
  });

  it('rewrites the version, and the digest where one is pinned', async () => {
    const dir = repo(EVERY_KIND);
    await raise(dir);

    expect(JSON.parse(read(dir, 'package.json'))).toEqual({
      packageManager: 'bun@1.4.5',
      engines: { bun: '>=1.4.5' },
      devDependencies: { bun: '1.0.0' },
    });
    expect(read(dir, 'apps/web/package.json')).toBe(
      '{ "packageManager": "bun@1.4.5" }\n',
    );
    expect(read(dir, 'Dockerfile')).toBe(
      `ARG BUN_VERSION=1.4.5\nFROM oven/bun:1.4.5-slim@${digestFor('1.4.5-slim')} AS build\nFROM docker.io/oven/bun:1.4.5-alpine\n`,
    );
    expect(read(dir, 'apps/api/Dockerfile.prod')).toBe(
      'FROM mirror.gcr.io/oven/bun:1.4.5\n',
    );
    expect(read(dir, '.github/workflows/ci.yml')).toContain(
      'bun-version: "1.4.5"\n    env:\n      BUN_VERSION: 1.4.5\n',
    );
    expect(read(dir, '.bun-version')).toBe('1.4.5\n');
    expect(read(dir, '.tool-versions')).toBe('nodejs 24.0.0\nbun 1.4.5\n');
  });
});

describe('raiseBunPins limits', () => {
  it('never lowers a pin and leaves excluded files alone', async () => {
    const files: Files = [
      ['package.json', '{ "packageManager": "bun@1.5.0" }\n'],
      ['managed.yml', 'bun-version: 1.4.3\n'],
      ['Dockerfile', 'FROM oven/bun:1.4.5\n'],
    ];
    const dir = repo(files);

    expect(await raise(dir, ['managed.yml'])).toMatchObject({
      raised: [],
      kept: [],
    });
    for (const [path, content] of files) {
      expect(read(dir, path)).toBe(content);
    }
    expect(resolved).toEqual([]);
  });

  it('leaves a range and look-alike names alone', async () => {
    const files: Files = [
      ['package.json', '{ "engines": { "bun": "^1.4.3" } }\n'],
      ['ci.yml', 'MY_BUN_VERSION: 1.4.3\nimage: example/oven/bun:1.4.3\n'],
      ['notes.md', 'FROM oven/bun:1.4.3\n'],
    ];
    const dir = repo(files);

    expect(await raise(dir)).toMatchObject({ raised: [], kept: [] });
    for (const [path, content] of files) {
      expect(read(dir, path)).toBe(content);
    }
  });

  it('writes through no tracked symlink', async () => {
    const outside = mkTmp('bun-pins-outside-');
    write(outside, 'Dockerfile', 'ARG BUN_VERSION=1.4.3\n');
    const dir = repo([['managed.yml', 'bun-version: 1.4.3\n']]);
    symlinkSync('managed.yml', join(dir, 'alias.yml'));
    mkdirSync(join(dir, 'api'));
    symlinkSync(join(outside, 'Dockerfile'), join(dir, 'api/Dockerfile'));
    execFileSync('git', ['add', '--all'], { cwd: dir });

    expect(await raise(dir, ['managed.yml'])).toMatchObject({ raised: [] });
    expect(read(dir, 'managed.yml')).toBe('bun-version: 1.4.3\n');
    expect(read(outside, 'Dockerfile')).toBe('ARG BUN_VERSION=1.4.3\n');
  });

  it('keeps a digest-pinned image outside Docker Hub and reports it', async () => {
    const dir = repo([
      [
        'Dockerfile',
        `FROM ghcr.io/oven/bun:1.4.3@${OLD_DIGEST}\nARG BUN_VERSION=1.4.3\n`,
      ],
    ]);

    expect(await raise(dir)).toMatchObject({
      raised: [{ path: 'Dockerfile', from: ['1.4.3'] }],
      kept: [
        'Dockerfile: ghcr.io/oven/bun:1.4.3 (outside Docker Hub, so its digest has no resolver)',
      ],
    });
    expect(read(dir, 'Dockerfile')).toBe(
      `FROM ghcr.io/oven/bun:1.4.3@${OLD_DIGEST}\nARG BUN_VERSION=1.4.5\n`,
    );
  });

  it('only plans without a digest resolver', async () => {
    const dir = repo([['Dockerfile', `FROM oven/bun:1.4.3@${OLD_DIGEST}\n`]]);
    const result = await raise(dir, [], null);

    expect(result?.raised).toEqual([{ path: 'Dockerfile', from: ['1.4.3'] }]);
    expect(read(dir, 'Dockerfile')).toBe(`FROM oven/bun:1.4.3@${OLD_DIGEST}\n`);
  });

  it('raises every other pin when Docker Hub lacks a tag', async () => {
    const dir = repo([
      ['package.json', '{ "packageManager": "bun@1.4.3" }\n'],
      ['Dockerfile', 'FROM oven/bun:1.4.3-gone\nARG BUN_VERSION=1.4.3\n'],
    ]);

    expect(
      await raise(dir, [], (tag) => Promise.reject(new Error(`no ${tag}`))),
    ).toMatchObject({
      raised: [
        { path: 'Dockerfile', from: ['1.4.3'] },
        { path: 'package.json', from: ['1.4.3'] },
      ],
      kept: [
        "Dockerfile: oven/bun:1.4.3-gone (Docker Hub didn't resolve oven/bun:1.4.5-gone: no 1.4.5-gone)",
      ],
      unresolved: ['1.4.5-gone'],
    });
    expect(read(dir, 'package.json')).toBe(
      '{ "packageManager": "bun@1.4.5" }\n',
    );
    expect(read(dir, 'Dockerfile')).toBe(
      'FROM oven/bun:1.4.3-gone\nARG BUN_VERSION=1.4.5\n',
    );
  });

  it('returns null outside a git checkout', async () => {
    const dir = mkTmp('bun-pins-plain-');
    write(dir, 'package.json', '{ "packageManager": "bun@1.4.3" }\n');

    expect(await raise(dir)).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders versions numerically', () => {
    expect(
      ['1.10.0', '1.4.5', '1.4.10', '0.9.9'].toSorted(compareVersions),
    ).toEqual(['0.9.9', '1.4.5', '1.4.10', '1.10.0']);
  });
});
