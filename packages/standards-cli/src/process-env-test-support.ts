import process from 'node:process';

export const restoreProcessEnv = (
  key: string,
  value: string | undefined,
): void => {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
};
