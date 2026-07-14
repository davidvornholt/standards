import { runPromise } from './release-effect';
import {
  inspectNpmRelease,
  npmIntegrity,
  type ReleaseFetcher,
} from './release-npm';
import { packReleaseArtifact, SOURCE_COMMIT_FILE } from './release-package';
import { argv, file, spawn, write } from './release-runtime';

const SHA_LENGTH = 40;
const HTTP_OK = 200;
export const PUBLISHED_SHA = 'a'.repeat(SHA_LENGTH);
export const CURRENT_SHA = 'b'.repeat(SHA_LENGTH);
export const TARBALL_URL = 'https://registry.example/standards.tgz';

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
        name: '@davidvornholt/standards',
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
      gitHead: 'caller-owned-stale-sha',
      name: '@davidvornholt/standards',
      version: '0.5.0',
    }),
  );
  const artifact = await runPromise(
    packReleaseArtifact({
      destination: markedDestination,
      expectedSha: PUBLISHED_SHA,
      packagePath,
    }),
  );
  const integrity = await runPromise(npmIntegrity(artifact));
  const metadata = (
    overrides: Record<string, unknown> = {},
    latest = '0.5.0',
    version = '0.5.0',
  ) => ({
    'dist-tags': { latest },
    versions: {
      [version]: {
        dist: { integrity, tarball: TARBALL_URL },
        ...overrides,
      },
    },
  });
  const fetchRegistry =
    (input: {
      readonly artifactPath?: string;
      readonly metadataBody: unknown;
      readonly metadataStatus?: number;
      readonly tarballStatus?: number;
    }): ReleaseFetcher =>
    (url) => {
      if (String(url) === TARBALL_URL) {
        return file(input.artifactPath ?? artifact)
          .arrayBuffer()
          .then(
            (bytes) =>
              new Response(bytes, {
                status: input.tarballStatus ?? HTTP_OK,
              }),
          );
      }
      return Promise.resolve(
        Response.json(input.metadataBody, {
          status: input.metadataStatus ?? HTTP_OK,
        }),
      );
    };
  const effect = (fetcher: ReleaseFetcher) =>
    inspectNpmRelease({
      currentSha: CURRENT_SHA,
      fetcher,
      name: '@davidvornholt/standards',
      version: '0.5.0',
    });
  return {
    artifact,
    dispose: () => run(['rm', '-rf', directory]),
    effect,
    fetchRegistry,
    integrity,
    metadata,
    unmarkedArtifact,
    unmarkedIntegrity,
  };
};

export type ReleaseNpmTestFixture = Awaited<
  ReturnType<typeof createReleaseNpmTestFixture>
>;
