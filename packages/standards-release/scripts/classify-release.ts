import { parseStableVersion } from '../src/release-declaration';
import {
  appendClassifyReleaseOutput,
  classifyReleaseArguments,
  setClassifyReleaseExitCode,
  writeClassifyReleaseError,
} from './classify-release-runtime';

const FAILURE_EXIT_CODE = 1;
const SUCCESS_EXIT_CODE = 0;

const required = (value: string | undefined, name: string) =>
  value === undefined || value === ''
    ? { message: `${name} is required`, ok: false as const }
    : { ok: true as const, value };

const reportError = (message: string): Promise<typeof FAILURE_EXIT_CODE> =>
  writeClassifyReleaseError(`::error::${message}\n`).then(
    () => FAILURE_EXIT_CODE,
  );

const main = (): Promise<
  typeof FAILURE_EXIT_CODE | typeof SUCCESS_EXIT_CODE
> => {
  const [output, version] = classifyReleaseArguments;
  const outputPath = required(output, 'GitHub output path');
  if (!outputPath.ok) {
    return reportError(outputPath.message);
  }
  const releaseVersion = required(version, 'release version');
  if (!releaseVersion.ok) {
    return reportError(releaseVersion.message);
  }
  if (parseStableVersion(releaseVersion.value) === null) {
    return reportError(
      `Version ${releaseVersion.value} must be a stable SemVer`,
    );
  }
  return appendClassifyReleaseOutput(outputPath.value, {
    tag: `v${releaseVersion.value}`,
    version: releaseVersion.value,
  })
    .then((): typeof SUCCESS_EXIT_CODE => SUCCESS_EXIT_CODE)
    .catch((cause: unknown) =>
      reportError(`Writing GitHub outputs failed: ${String(cause)}`),
    );
};

setClassifyReleaseExitCode(await main());
