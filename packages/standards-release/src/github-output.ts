import { file, write } from './release-runtime';

export type GithubOutputValues = Readonly<Record<string, string | boolean>>;

export const encodeGithubOutput = (values: GithubOutputValues): string =>
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');

export const appendGithubOutput = (
  output: string,
  values: GithubOutputValues,
): Promise<void> =>
  file(output)
    .exists()
    .then((exists) => (exists ? file(output).text() : Promise.resolve('')))
    .then((current) => write(output, `${current}${encodeGithubOutput(values)}`))
    .then(() => undefined);
