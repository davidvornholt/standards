import { spawnSync } from 'node:child_process';

// Decrypted values are safe only when git proves it will ignore them.
export const devEnvGitIgnoreProblem = (
  consumer: string,
  rel: string,
): string | null => {
  const result = spawnSync('git', ['check-ignore', '-q', '--', rel], {
    cwd: consumer,
    encoding: 'utf8',
  });
  if (result.error !== undefined || result.status === null) {
    return `cannot run git to verify ${rel} is gitignored`;
  }
  if (result.status === 0) {
    return null;
  }
  if (result.status === 1) {
    return `${rel} is not gitignored; ignore it before generating dev env files`;
  }
  return `cannot verify ${rel} is gitignored (git check-ignore exited ${result.status})`;
};
