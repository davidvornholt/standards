import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'bun';
import { appendGithubOutput, encodeGithubOutput } from './github-output';
import { file } from './release-runtime';

const directories: Array<string> = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    spawnSync(['rm', '-rf', directory]);
  }
});

describe('GitHub output', () => {
  it('encodes and appends values through one dependency-free owner', async () => {
    const directory = spawnSync(['mktemp', '-d', '/tmp/github-output-XXXXXX'])
      .stdout.toString()
      .trim();
    directories.push(directory);
    const output = `${directory}/output`;
    expect(encodeGithubOutput({ declared: true, version: '0.5.0' })).toBe(
      'declared=true\nversion=0.5.0\n',
    );
    await appendGithubOutput(output, { declared: true });
    await appendGithubOutput(output, { version: '0.5.0' });
    expect(await file(output).text()).toBe('declared=true\nversion=0.5.0\n');
  });
});
