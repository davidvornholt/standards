import {
  encodeGithubOutput,
  type GithubOutputValues,
} from './github-output-values';
import { file, write } from './release-runtime';

export const appendGithubOutput = (
  output: string,
  values: GithubOutputValues,
): Promise<void> =>
  file(output)
    .exists()
    .then((exists) => (exists ? file(output).text() : Promise.resolve('')))
    .then((current) => write(output, `${current}${encodeGithubOutput(values)}`))
    .then(() => undefined);
