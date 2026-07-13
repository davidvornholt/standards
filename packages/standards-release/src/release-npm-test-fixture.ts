import { runPromise } from './release-effect';
import {
  inspectNpmRelease,
  npmIntegrity,
  type ReleaseFetcher,
} from './release-npm';
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

export const createReleaseNpmTestFixture = async () => {
  const directory = `/tmp/release-npm-${crypto.randomUUID()}`;
  const packagePath = `${directory}/package`;
  const markedDestination = `${directory}/marked`;
  const unmarkedDestination = `${directory}/unmarked`;
  await run([
    'mkdir',
    '-p',
    packagePath,
    markedDestination,
    unmarkedDestination,
  ]);
  await Promise.all([
    write(`${packagePath}/index.js`, 'export const value = true;\n'),
    write(
      `${packagePath}/package.json`,
      JSON.stringify({
        files: ['index.js'],
        name: '@test/npm-inspection',
        version: '0.5.0',
      }),
    ),
  ]);
  const unmarkedPack = await run([
    argv[0] ?? 'bun',
    'pm',
    'pack',
    '--cwd',
    packagePath,
    '--destination',
    unmarkedDestination,
    '--ignore-scripts',
    '--quiet',
  ]);
  const unmarkedArtifact = unmarkedPack.stdout.trim();
  const unmarkedIntegrity = await runPromise(npmIntegrity(unmarkedArtifact));
  await write(
    `${packagePath}/package.json`,
    JSON.stringify({
      files: ['index.js', SOURCE_COMMIT_FILE],
      name: '@test/npm-inspection',
      version: '0.5.0',
    }),
  );
  const artifact = await runPromise(
    packReleaseArtifact({
      destination: markedDestination,
      expectedSha: 'expected',
      packagePath,
    }),
  );
  const integrity = await runPromise(npmIntegrity(artifact));
  const metadata = (
    overrides: Record<string, unknown> = {},
    latest = '0.5.0',
    artifactIntegrity = integrity,
  ) => ({
    'dist-tags': { latest },
    versions: {
      '0.5.0': {
        dist: { integrity: artifactIntegrity },
        gitHead: 'expected',
        ...overrides,
      },
    },
  });
  const fetchJson =
    (body: unknown, status = 200): ReleaseFetcher =>
    () =>
      Promise.resolve(Response.json(body, { status }));
  const effect = (fetcher: ReleaseFetcher) =>
    inspectNpmRelease({
      artifact,
      expectedSha: 'expected',
      fetcher,
      name: '@davidvornholt/standards',
      parentVersion: '0.4.0',
      version: '0.5.0',
    });
  return {
    artifact,
    dispose: () => run(['rm', '-rf', directory]),
    effect,
    fetchJson,
    integrity,
    metadata,
    unmarkedArtifact,
    unmarkedIntegrity,
  };
};

export type ReleaseNpmTestFixture = Awaited<
  ReturnType<typeof createReleaseNpmTestFixture>
>;
