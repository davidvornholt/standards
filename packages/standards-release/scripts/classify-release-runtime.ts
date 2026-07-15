import {
  encodeGithubOutput,
  type GithubOutputValues,
} from '../src/github-output-values';

type ClassifierFileSystem = {
  readonly appendFile: (
    path: string,
    contents: string,
    encoding: 'utf8',
  ) => Promise<void>;
};

type ClassifierProcess = {
  readonly argv: ReadonlyArray<string>;
  exitCode: number | undefined;
  readonly stderr: {
    readonly write: (
      message: string,
      callback: (error?: Error | null) => void,
    ) => void;
  };
};

const fileSystem = (await import(
  ['node', 'fs/promises'].join(':')
)) as unknown as ClassifierFileSystem;
const processModule = (await import(['node', 'process'].join(':'))) as {
  readonly default: ClassifierProcess;
};
const runtimeProcess = processModule.default;

export const classifyReleaseArguments = runtimeProcess.argv.slice(2);

export const appendClassifyReleaseOutput = (
  output: string,
  values: GithubOutputValues,
): Promise<void> =>
  fileSystem.appendFile(output, encodeGithubOutput(values), 'utf8');

export const writeClassifyReleaseError = (message: string): Promise<void> =>
  new Promise((resolve, reject) => {
    runtimeProcess.stderr.write(message, (error) => {
      if (error === null || error === undefined) {
        resolve();
        return;
      }
      reject(error);
    });
  });

export const setClassifyReleaseExitCode = (exitCode: number): void => {
  runtimeProcess.exitCode = exitCode;
};
