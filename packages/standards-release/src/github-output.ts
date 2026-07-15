import {
  encodeGithubOutput,
  type GithubOutputValues,
} from './github-output-values';
import { gen, tryPromise } from './release-effect';
import { ReleaseOutputError } from './release-output-error';
import { file, write } from './release-runtime';

const outputFailure = (operation: string, cause: unknown) =>
  new ReleaseOutputError({
    message: `Writing GitHub outputs failed while ${operation}: ${String(cause)}`,
  });

export const appendGithubOutput = (
  output: string,
  values: GithubOutputValues,
) =>
  gen(function* () {
    const outputFile = file(output);
    const exists = yield* tryPromise({
      try: () => outputFile.exists(),
      catch: (cause) => outputFailure('inspecting the output file', cause),
    });
    const current = exists
      ? yield* tryPromise({
          try: () => outputFile.text(),
          catch: (cause) => outputFailure('reading the output file', cause),
        })
      : '';
    yield* tryPromise({
      try: () => write(output, `${current}${encodeGithubOutput(values)}`),
      catch: (cause) => outputFailure('appending values', cause),
    });
  });
