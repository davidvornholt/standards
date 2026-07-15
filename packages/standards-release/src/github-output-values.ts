export type GithubOutputValues = Readonly<Record<string, string | boolean>>;

export const encodeGithubOutput = (values: GithubOutputValues): string =>
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
