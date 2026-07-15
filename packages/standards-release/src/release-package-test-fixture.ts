import { SOURCE_COMMIT_FILE } from './release-package';
import { spawnSync, write } from './release-runtime';

export const releasePackageTestEnvironment = () => {
  const directories: Array<string> = [];
  return {
    cleanup: (): void => {
      for (const directory of directories.splice(0)) {
        spawnSync(['rm', '-rf', directory]);
      }
    },
    temporaryDirectory: (label: string): string => {
      const directory = spawnSync(['mktemp', '-d', `/tmp/${label}-XXXXXX`])
        .stdout.toString()
        .trim();
      directories.push(directory);
      return directory;
    },
    trackDirectory: (directory: string): void => {
      directories.push(directory);
    },
  };
};

export const createReleasePackage = (
  directory: string,
  options: { readonly publicTree?: boolean } = {},
): Promise<number> => {
  if (options.publicTree === true) {
    spawnSync([
      'mkdir',
      '-p',
      `${directory}/nested`,
      `${directory}/node_modules/dependency`,
      `${directory}/.turbo`,
      `${directory}/.git`,
    ]);
  }
  const publicFiles =
    options.publicTree === true
      ? [
          write(
            `${directory}/nested/public.js`,
            'export const nested = true;\n',
          ),
          write(`${directory}/node_modules/dependency/index.js`, 'excluded\n'),
          write(`${directory}/.turbo/log`, 'excluded\n'),
          write(`${directory}/.git/config`, 'excluded\n'),
        ]
      : [];
  return Promise.all([
    write(
      `${directory}/package.json`,
      JSON.stringify({
        files:
          options.publicTree === true
            ? ['index.js', 'nested', SOURCE_COMMIT_FILE]
            : ['index.js', SOURCE_COMMIT_FILE],
        ...(options.publicTree === true
          ? { gitHead: 'caller-owned-git-head' }
          : {}),
        name: '@test/release-artifact',
        version: '1.0.0',
      }),
    ),
    write(`${directory}/index.js`, 'export const value = true;\n'),
    ...publicFiles,
  ]).then(([manifestBytes]) => manifestBytes ?? 0);
};
