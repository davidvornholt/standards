import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { runGithubApply } from './github-commands';

const tmps: Array<string> = [];
const originalFetch = globalThis.fetch;
const originalToken = process.env.GH_TOKEN;
const ALLOW_AUTO_MERGE = 'allow_auto_merge';

const temporaryDirectory = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'github-declaration-'));
  tmps.push(path);
  return path;
};

const write = (root: string, rel: string, contents: string): void => {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
};

const settings = (allowAutoMerge: boolean): string =>
  JSON.stringify({
    environments: [],
    repository: { [ALLOW_AUTO_MERGE]: allowAutoMerge },
    rulesets: [],
  });

const consumerRepository = (): string => {
  const consumer = temporaryDirectory();
  write(consumer, '.github/settings.json', settings(true));
  write(
    consumer,
    '.github/settings.local.json',
    JSON.stringify({ environments: [], repository: {}, rulesets: [] }),
  );
  execFileSync('git', ['-C', consumer, 'init', '--quiet']);
  execFileSync('git', [
    '-C',
    consumer,
    'remote',
    'add',
    'origin',
    'https://github.com/example/repository.git',
  ]);
  return consumer;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) {
    delete process.env.GH_TOKEN;
  } else {
    process.env.GH_TOKEN = originalToken;
  }
  while (tmps.length > 0) {
    const path = tmps.pop();
    if (path !== undefined) {
      rmSync(path, { force: true, recursive: true });
    }
  }
});

describe('GitHub declaration filesystem boundary', () => {
  for (const target of ['file', 'parent'] as const) {
    it(`rejects a symbolic-link declaration ${target} before requests`, async () => {
      const consumer = consumerRepository();
      const outside = temporaryDirectory();
      if (target === 'file') {
        write(outside, 'settings.json', settings(true));
        rmSync(join(consumer, '.github/settings.json'));
        symlinkSync(
          join(outside, 'settings.json'),
          join(consumer, '.github/settings.json'),
        );
      } else {
        rmSync(join(consumer, '.github'), { recursive: true });
        write(outside, 'settings.json', settings(true));
        write(
          outside,
          'settings.local.json',
          JSON.stringify({ environments: [], repository: {}, rulesets: [] }),
        );
        symlinkSync(outside, join(consumer, '.github'));
      }
      let requests = 0;
      globalThis.fetch = (() => {
        requests += 1;
        return Promise.reject(new Error('unexpected request'));
      }) as unknown as typeof fetch;

      await expect(runGithubApply(consumer)).rejects.toThrow(
        'must not be a symbolic link',
      );
      expect(requests).toBe(0);
    });
  }

  it('makes no mutation when the validated declaration is replaced', async () => {
    const consumer = consumerRepository();
    process.env.GH_TOKEN = 'test-token';
    const methods: Array<string> = [];
    globalThis.fetch = ((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (methods.length === 1) {
        write(consumer, '.github/settings.next', settings(false));
        renameSync(
          join(consumer, '.github/settings.next'),
          join(consumer, '.github/settings.json'),
        );
        return Promise.resolve(Response.json({ [ALLOW_AUTO_MERGE]: false }));
      }
      return Promise.resolve(Response.json([]));
    }) as unknown as typeof fetch;

    expect(await runGithubApply(consumer)).toBe(false);
    expect(methods).toEqual(['GET', 'GET']);
  });
});
