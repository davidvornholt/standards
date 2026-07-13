import { appendFileSync } from 'node:fs';
import process from 'node:process';
import {
  inspectGithubRelease,
  reconcileGithubRelease,
} from '../src/release-github';
import { inspectNpmRelease } from '../src/release-npm';
import {
  classifyReleaseDeclaration,
  decideReconciliation,
  decideRelease,
} from '../src/release-state';

// biome-ignore lint/style/noProcessEnv: This workflow entrypoint receives its deployment configuration from GitHub Actions.
const environment = process.env;

const requireArg = (value: string | undefined, name: string): string => {
  if (value === undefined || value === '') {
    throw new Error(`${name} is required`);
  }
  return value;
};

const nullableArg = (value: string | undefined): string | null => {
  const present = value ?? '';
  return present === '' ? null : present;
};

const parseBoolean = (value: string | undefined, name: string): boolean => {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`${name} must be true or false`);
};

const writeOutput = (
  output: string,
  values: Readonly<Record<string, string | boolean>>,
): void => {
  const lines = Object.entries(values).map(
    ([key, value]) => `${key}=${value}\n`,
  );
  appendFileSync(output, lines.join(''));
};

const unwrap = <T>(
  result:
    | { readonly error: string; readonly ok: false }
    | {
        readonly ok: true;
        readonly value: T;
      },
): T => {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
};

const classify = (args: ReadonlyArray<string>): void => {
  const [output, version, parentVersion] = args;
  const requiredVersion = requireArg(version, 'release version');
  const declared = unwrap(
    classifyReleaseDeclaration({
      parentVersion: nullableArg(parentVersion),
      version: requiredVersion,
    }),
  );
  writeOutput(requireArg(output, 'GitHub output path'), {
    declared,
    tag: `v${requiredVersion}`,
    version: requiredVersion,
  });
};

const plan = (args: ReadonlyArray<string>): void => {
  const [output, version, parentVersion, npmLatest, npmVersionExists] = args;
  const result = decideRelease({
    npmLatest: nullableArg(npmLatest),
    npmVersionExists: parseBoolean(npmVersionExists, 'npm version existence'),
    parentVersion: nullableArg(parentVersion),
    version: requireArg(version, 'release version'),
  });
  writeOutput(requireArg(output, 'GitHub output path'), unwrap(result));
};

const reconcile = (args: ReadonlyArray<string>): void => {
  const [output, expectedSha, releaseStatus, tagSha] = args;
  const status = requireArg(releaseStatus, 'release status');
  if (!(status === 'absent' || status === 'draft' || status === 'published')) {
    throw new Error(`Unsupported release status ${status}`);
  }
  const action = unwrap(
    decideReconciliation({
      expectedSha: requireArg(expectedSha, 'release sha'),
      releaseStatus: status,
      tagSha: nullableArg(tagSha),
    }),
  );
  writeOutput(requireArg(output, 'GitHub output path'), { action });
};

const inspectNpm = async (args: ReadonlyArray<string>): Promise<void> => {
  const [output, name, version, parentVersion, artifact, expectedSha] = args;
  const inspection = unwrap(
    await inspectNpmRelease({
      artifact: requireArg(artifact, 'package artifact'),
      expectedSha: requireArg(expectedSha, 'release sha'),
      name: requireArg(name, 'package name'),
      parentVersion: nullableArg(parentVersion),
      version: requireArg(version, 'release version'),
    }),
  );
  writeOutput(requireArg(output, 'GitHub output path'), inspection);
};

const github = async (
  mode: 'inspect' | 'reconcile',
  args: ReadonlyArray<string>,
): Promise<void> => {
  const [output, expectedSha, tag] = args;
  const input = {
    expectedSha: requireArg(expectedSha, 'release sha'),
    repo: requireArg(environment.GITHUB_REPOSITORY, 'GitHub repository'),
    tag: requireArg(tag, 'release tag'),
    token: requireArg(
      environment.GH_TOKEN ?? environment.GITHUB_TOKEN,
      'GitHub token',
    ),
  };
  const action = unwrap(
    mode === 'inspect'
      ? await inspectGithubRelease(input)
      : await reconcileGithubRelease(input),
  );
  writeOutput(requireArg(output, 'GitHub output path'), { action });
};

const main = async (): Promise<void> => {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'classify') {
    classify(args);
  } else if (command === 'plan') {
    plan(args);
  } else if (command === 'reconcile') {
    reconcile(args);
  } else if (command === 'npm') {
    await inspectNpm(args);
  } else if (command === 'github-inspect') {
    await github('inspect', args);
  } else if (command === 'github-reconcile') {
    await github('reconcile', args);
  } else {
    throw new Error(
      'Expected release-state command classify, plan, reconcile, npm, github-inspect, or github-reconcile',
    );
  }
};

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`::error::${message}\n`);
  process.exit(1);
}
