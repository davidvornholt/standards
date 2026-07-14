import { runPromise } from './release-effect';
import { npmIntegrity } from './release-npm';
import { packReleaseArtifact, SOURCE_COMMIT_FILE } from './release-package';
import { argv, spawn, write } from './release-runtime';

const run = (command: ReadonlyArray<string>) => {
  const subprocess = spawn([...command], { stderr: 'pipe', stdout: 'pipe' });
  return Promise.all([
    subprocess.exited,
    new Response(subprocess.stderr).text(),
    new Response(subprocess.stdout).text(),
  ]).then(([exitCode, stderr, stdout]) => ({ exitCode, stderr, stdout }));
};

const runGit = (repository: string, args: ReadonlyArray<string>) =>
  run(['git', '-C', repository, ...args]).then((result) => {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `git ${args.join(' ')} failed`);
    }
    return result.stdout.trim();
  });

const initializeSource = async (input: {
  readonly packagePath: string;
  readonly repository: string;
  readonly scriptSentinel: string;
}) => {
  await Promise.all([
    write(
      `${input.repository}/package.json`,
      `${JSON.stringify({ private: true, workspaces: ['packages/*'] }, null, 2)}\n`,
    ),
    write(`${input.packagePath}/LICENSE`, 'test license\n'),
    write(`${input.packagePath}/README.md`, '# Test package\n'),
    write(`${input.packagePath}/index.js`, 'export const value = true;\n'),
    write(
      `${input.packagePath}/package.json`,
      `${JSON.stringify(
        {
          files: ['index.js', SOURCE_COMMIT_FILE],
          name: '@davidvornholt/standards',
          scripts: { prepack: `touch ${input.scriptSentinel}` },
          version: '0.5.0',
        },
        null,
        2,
      )}\n`,
    ),
  ]);
  await runGit(input.repository, ['init', '-b', 'main']);
  await runGit(input.repository, [
    'config',
    'user.email',
    'release@example.test',
  ]);
  await runGit(input.repository, ['config', 'user.name', 'Release test']);
  await runGit(input.repository, ['config', 'commit.gpgsign', 'false']);
  await runGit(input.repository, ['config', 'tag.gpgsign', 'false']);
  await runGit(input.repository, ['add', '.']);
  await runGit(input.repository, [
    'commit',
    '--no-gpg-sign',
    '-m',
    'release source',
  ]);
  return runGit(input.repository, ['rev-parse', 'HEAD']);
};

const createPlainArtifact = async (
  packagePath: string,
  destination: string,
) => {
  const result = await run([
    argv[0] ?? 'bun',
    'pm',
    'pack',
    '--cwd',
    packagePath,
    '--destination',
    destination,
    '--ignore-scripts',
    '--quiet',
  ]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
};

const createDivergedHistory = async (
  repository: string,
  publishedSha: string,
) => {
  await runGit(repository, [
    'tag',
    '--annotate',
    '--message',
    'candidate tag object',
    'candidate-object',
    publishedSha,
  ]);
  const annotatedTagSha = await runGit(repository, [
    'rev-parse',
    'refs/tags/candidate-object',
  ]);
  await runGit(repository, ['checkout', '-b', 'unrelated']);
  await write(`${repository}/unrelated`, 'unrelated history\n');
  await runGit(repository, ['add', 'unrelated']);
  await runGit(repository, [
    'commit',
    '--no-gpg-sign',
    '-m',
    'unrelated commit',
  ]);
  const nonAncestorSha = await runGit(repository, ['rev-parse', 'HEAD']);
  await runGit(repository, ['checkout', 'main']);
  await write(`${repository}/current`, 'tested descendant\n');
  await runGit(repository, ['add', 'current']);
  await runGit(repository, [
    'commit',
    '--no-gpg-sign',
    '-m',
    'tested descendant',
  ]);
  const currentSha = await runGit(repository, ['rev-parse', 'HEAD']);
  await runGit(repository, ['replace', '--graft', currentSha, nonAncestorSha]);
  return { annotatedTagSha, currentSha, nonAncestorSha };
};

export const createReleaseNpmGitFixture = async () => {
  const directory = `/tmp/release-npm-${crypto.randomUUID()}`;
  const repository = `${directory}/repository`;
  const packagePath = `${repository}/packages/standards-cli`;
  const temporaryDirectory = `${directory}/temporary`;
  const scriptSentinel = `${directory}/candidate-script-ran`;
  const destinations = ['marked', 'unmarked', 'alternate'];
  await run([
    'mkdir',
    '-p',
    packagePath,
    temporaryDirectory,
    ...destinations.map((name) => `${directory}/${name}`),
  ]);
  const publishedSha = await initializeSource({
    packagePath,
    repository,
    scriptSentinel,
  });
  const unmarkedArtifact = await createPlainArtifact(
    packagePath,
    `${directory}/unmarked`,
  );
  const unmarkedIntegrity = await runPromise(npmIntegrity(unmarkedArtifact));
  const artifact = await runPromise(
    packReleaseArtifact({
      destination: `${directory}/marked`,
      expectedSha: publishedSha,
      packagePath,
    }),
  );
  const integrity = await runPromise(npmIntegrity(artifact));
  const history = await createDivergedHistory(repository, publishedSha);
  await write(`${packagePath}/index.js`, 'export const value = "wrong";\n');
  const mismatchedArtifact = await runPromise(
    packReleaseArtifact({
      destination: `${directory}/alternate`,
      expectedSha: publishedSha,
      packagePath,
    }),
  );
  const mismatchedIntegrity = await runPromise(
    npmIntegrity(mismatchedArtifact),
  );
  await runGit(repository, ['restore', 'packages/standards-cli/index.js']);
  return {
    artifact,
    directory,
    integrity,
    mismatchedArtifact,
    mismatchedIntegrity,
    packagePath,
    publishedSha,
    repository,
    scriptSentinel,
    temporaryDirectory,
    unmarkedArtifact,
    unmarkedIntegrity,
    ...history,
  };
};

export const removeReleaseNpmGitFixture = (directory: string) =>
  run(['rm', '-rf', directory]);
