const FULL_LOWERCASE_COMMIT_SHA = /^[0-9a-f]{40}$/u;

export const isReleaseSourceSha = (value: string): boolean =>
  FULL_LOWERCASE_COMMIT_SHA.test(value);
