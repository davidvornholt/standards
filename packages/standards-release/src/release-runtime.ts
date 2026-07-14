type RuntimeProcess = {
  exitCode: number | undefined;
};

type RuntimeFileIdentity = {
  readonly dev: bigint;
  readonly ino: bigint;
};

type RuntimeFileHandle = {
  readonly close: () => Promise<void>;
  readonly stat: (options: {
    readonly bigint: true;
  }) => Promise<RuntimeFileIdentity>;
  readonly writeFile: (contents: string) => Promise<void>;
};

type RuntimeFileSystem = {
  readonly link: (existingPath: string, newPath: string) => Promise<void>;
  readonly lstat: (
    path: string,
    options: { readonly bigint: true },
  ) => Promise<RuntimeFileIdentity>;
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly open: (path: string, flags: string) => Promise<RuntimeFileHandle>;
  readonly rename: (oldPath: string, newPath: string) => Promise<void>;
  readonly rmdir: (path: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
};

// Dynamic loading avoids a Biome 2.5.3 resolver failure on Bun's static exports and isolates the Node-compatible process edge in this private runtime adapter.
const runtime = await import('bun');
const fileSystem = (await import(
  ['node', 'fs/promises'].join(':')
)) as unknown as RuntimeFileSystem;
const processModule = (await import(['node', 'process'].join(':'))) as {
  readonly default: RuntimeProcess;
};

export const { argv, env, file, spawn, stderr, write } = runtime;
export const {
  link: nodeLink,
  lstat: nodeLstat,
  mkdtemp: nodeMkdtemp,
  open: nodeOpenFile,
  rename: nodeRename,
  rmdir: nodeRmdir,
  unlink: nodeUnlink,
} = fileSystem;
export const BunCryptoHasher = runtime.CryptoHasher;
export const runtimeProcess = processModule.default;
