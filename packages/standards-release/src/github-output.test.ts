import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'bun';
import { appendGithubOutput } from './github-output';
import { encodeGithubOutput } from './github-output-values';
import { flip, runPromise } from './release-effect';
import { file } from './release-runtime';

const directories: Array<string> = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    spawnSync(['rm', '-rf', directory]);
  }
});

describe('GitHub output', () => {
  it('encodes values purely and appends them through Effect', async () => {
    const directory = spawnSync(['mktemp', '-d', '/tmp/github-output-XXXXXX'])
      .stdout.toString()
      .trim();
    directories.push(directory);
    const output = `${directory}/output`;
    expect(encodeGithubOutput({ declared: true, version: '0.5.0' })).toBe(
      'declared=true\nversion=0.5.0\n',
    );
    await runPromise(appendGithubOutput(output, { declared: true }));
    await runPromise(appendGithubOutput(output, { version: '0.5.0' }));
    expect(await file(output).text()).toBe('declared=true\nversion=0.5.0\n');
  });

  it('reports output failures through a specific Effect error', async () => {
    const directory = spawnSync(['mktemp', '-d', '/tmp/github-output-XXXXXX'])
      .stdout.toString()
      .trim();
    directories.push(directory);

    expect(
      await runPromise(
        flip(
          appendGithubOutput(directory, {
            declared: true,
          }),
        ),
      ),
    ).toMatchObject({
      _tag: 'ReleaseOutputError',
      message: expect.stringContaining(
        'Writing GitHub outputs failed while appending values',
      ),
    });
  });
});
