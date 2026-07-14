import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'bun';
import { file, env as runtimeEnvironment } from './release-runtime';

const packageRoot = `${import.meta.dir}/..`;
const directories: Array<string> = [];
const SHA_LENGTH = 40;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    spawnSync(['rm', '-rf', directory]);
  }
});

const run = (
  script: string,
  args: ReadonlyArray<string>,
  env?: Readonly<Record<string, string>>,
) => {
  const directory = spawnSync([
    'mktemp',
    '-d',
    '/tmp/release-state-script-XXXXXX',
  ])
    .stdout.toString()
    .trim();
  directories.push(directory);
  const output = `${directory}/output`;
  const result = spawnSync(
    [
      'bun',
      `scripts/${script}`,
      ...args.map((arg) => (arg === '$OUTPUT' ? output : arg)),
    ],
    {
      cwd: packageRoot,
      env: env === undefined ? undefined : { ...runtimeEnvironment, ...env },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  return (
    result.exitCode === 0 ? file(output).text() : Promise.resolve('')
  ).then((outputText) => ({
    exitCode: result.exitCode,
    output: outputText,
    stderr: result.stderr.toString(),
  }));
};

describe('release workflow wrappers', () => {
  it('validates declarations and writes stable workflow outputs', async () => {
    expect(await run('classify-release.ts', ['$OUTPUT', '0.5.0'])).toEqual({
      exitCode: 0,
      output: 'tag=v0.5.0\nversion=0.5.0\n',
      stderr: '',
    });
  });

  it('surfaces tagged validation and argument failures', async () => {
    const invalidVersion = await run('classify-release.ts', [
      '$OUTPUT',
      'not-semver',
    ]);
    expect(invalidVersion.exitCode).toBe(1);
    expect(invalidVersion.stderr).toContain(
      '::error::Version not-semver must be a stable SemVer',
    );
    const missingOutput = await run('classify-release.ts', ['', '0.5.0']);
    expect(missingOutput.exitCode).toBe(1);
    expect(missingOutput.stderr).toContain(
      '::error::GitHub output path is required',
    );
    const missingRepository = await run('release-state.ts', [
      'npm',
      '$OUTPUT',
      '@davidvornholt/standards',
      '0.5.0',
      'a'.repeat(SHA_LENGTH),
      '',
      '/tmp',
    ]);
    expect(missingRepository.exitCode).toBe(1);
    expect(missingRepository.stderr).toContain(
      '::error::repository path is required',
    );
  });

  it('uses a non-empty GITHUB_TOKEN when GH_TOKEN is empty', async () => {
    const result = await run(
      'release-state.ts',
      ['github-inspect', '$OUTPUT', 'expected', 'v0.5.0'],
      Object.fromEntries([
        ['GH_TOKEN', ''],
        ['GITHUB_REPOSITORY', ''],
        ['GITHUB_TOKEN', 'fallback'],
      ]),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('::error::GitHub repository is required');
    expect(result.stderr).not.toContain('GitHub token is required');
  });

  it('rejects an unknown command', async () => {
    const result = await run('release-state.ts', ['unknown']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      '::error::Expected release-state command pack, npm, github-authorize, github-inspect, or github-reconcile',
    );
  });
});
