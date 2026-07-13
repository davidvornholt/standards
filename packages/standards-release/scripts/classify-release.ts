import { appendGithubOutput } from '../src/github-output';
import { classifyReleaseDeclaration } from '../src/release-declaration';
import { argv, runtimeProcess, stderr, write } from '../src/release-runtime';

const FAILURE_EXIT_CODE = 1;
const SUCCESS_EXIT_CODE = 0;

const required = (value: string | undefined, name: string) =>
  value === undefined || value === ''
    ? { message: `${name} is required`, ok: false as const }
    : { ok: true as const, value };

const reportError = (message: string): Promise<typeof FAILURE_EXIT_CODE> =>
  write(stderr, `::error::${message}\n`).then(() => FAILURE_EXIT_CODE);

const main = (): Promise<
  typeof FAILURE_EXIT_CODE | typeof SUCCESS_EXIT_CODE
> => {
  const [output, version, parentVersion] = argv.slice(2);
  const outputPath = required(output, 'GitHub output path');
  if (!outputPath.ok) {
    return reportError(outputPath.message);
  }
  const releaseVersion = required(version, 'release version');
  if (!releaseVersion.ok) {
    return reportError(releaseVersion.message);
  }
  const classification = classifyReleaseDeclaration({
    parentVersion:
      parentVersion === undefined || parentVersion === ''
        ? null
        : parentVersion,
    version: releaseVersion.value,
  });
  if (!classification.ok) {
    return reportError(classification.message);
  }
  return appendGithubOutput(outputPath.value, {
    declared: classification.declared,
    tag: `v${releaseVersion.value}`,
    version: releaseVersion.value,
  })
    .then((): typeof SUCCESS_EXIT_CODE => SUCCESS_EXIT_CODE)
    .catch((cause: unknown) =>
      reportError(`Writing GitHub outputs failed: ${String(cause)}`),
    );
};

runtimeProcess.exitCode = await main();
