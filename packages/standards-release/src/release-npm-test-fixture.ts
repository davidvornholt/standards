import { inspectNpmRelease, type ReleaseFetcher } from './release-npm';
import {
  createReleaseNpmGitFixture,
  removeReleaseNpmGitFixture,
} from './release-npm-git-test-fixture';
import { file } from './release-runtime';

const HTTP_OK = 200;
export const TARBALL_URL = 'https://registry.example/standards.tgz';

export const createReleaseNpmTestFixture = async () => {
  const fixture = await createReleaseNpmGitFixture();
  const metadata = (
    overrides: Record<string, unknown> = {},
    latest = '0.5.0',
    version = '0.5.0',
    artifactIntegrity = fixture.integrity,
  ) => ({
    'dist-tags': { latest },
    versions: {
      [version]: {
        dist: { integrity: artifactIntegrity, tarball: TARBALL_URL },
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
        return file(input.artifactPath ?? fixture.artifact)
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
      currentSha: fixture.currentSha,
      fetcher,
      name: '@davidvornholt/standards',
      repositoryPath: fixture.repository,
      temporaryDirectory: fixture.temporaryDirectory,
      version: '0.5.0',
    });
  return {
    ...fixture,
    dispose: () => removeReleaseNpmGitFixture(fixture.directory),
    effect,
    fetchRegistry,
    metadata,
  };
};

export type ReleaseNpmTestFixture = Awaited<
  ReturnType<typeof createReleaseNpmTestFixture>
>;
