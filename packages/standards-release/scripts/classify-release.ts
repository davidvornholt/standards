import { classifyReleaseDeclaration } from '../src/release-declaration';
import {
  argv,
  file,
  runtimeProcess,
  stderr,
  write,
} from '../src/release-runtime';

const FAILURE_EXIT_CODE = 1;
const SUCCESS_EXIT_CODE = 0;

const required = (value: string | undefined, name: string) =>
  value === undefined || value === ''
    ? { message: `${name} is required`, ok: false as const }
    : { ok: true as const, value };

const appendOutput = (output: string, content: string): Promise<void> =>
  file(output)
    .exists()
    .then((exists) => (exists ? file(output).text() : Promise.resolve('')))
    .then((current) => write(output, `${current}${content}`))
    .then(() => undefined);

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
  return appendOutput(
    outputPath.value,
    `declared=${classification.declared}\ntag=v${releaseVersion.value}\nversion=${releaseVersion.value}\n`,
  )
    .then((): typeof SUCCESS_EXIT_CODE => SUCCESS_EXIT_CODE)
    .catch((cause: unknown) =>
      reportError(`Writing GitHub outputs failed: ${String(cause)}`),
    );
};

runtimeProcess.exitCode = await main();
