type RuntimeProcess = {
  exitCode: number | undefined;
};

type RuntimeFileSystem = {
  readonly lstat: (path: string) => Promise<unknown>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly rm: (
    path: string,
    options: { readonly force: boolean; readonly recursive: boolean },
  ) => Promise<void>;
};

type RuntimeCrypto = {
  readonly timingSafeEqual: (left: Uint8Array, right: Uint8Array) => boolean;
};

type RuntimeZlib = {
  readonly gzipSync: (
    input: Uint8Array,
    options: { readonly level: number; readonly mtime: number },
  ) => Uint8Array;
  readonly gunzipSync: (input: Uint8Array) => Uint8Array;
};

// Dynamic loading avoids a Biome 2.5.3 resolver failure on Bun's static exports and isolates the Node-compatible process edge in this private runtime adapter.
const runtime = await import('bun');
const fileSystem = (await import(
  ['node', 'fs/promises'].join(':')
)) as unknown as RuntimeFileSystem;
const zlib = (await import(
  ['node', 'zlib'].join(':')
)) as unknown as RuntimeZlib;
const crypto = (await import(
  ['node', 'crypto'].join(':')
)) as unknown as RuntimeCrypto;
const processModule = (await import(['node', 'process'].join(':'))) as {
  readonly default: RuntimeProcess;
};

export const { argv, env, file, spawn, spawnSync, stderr, version, write } =
  runtime;
export const {
  lstat: nodeLstat,
  mkdir: nodeMkdir,
  mkdtemp: nodeMkdtemp,
  rm: nodeRm,
} = fileSystem;
export const { gzipSync: nodeGzipSync, gunzipSync: nodeGunzipSync } = zlib;
export const { timingSafeEqual: nodeTimingSafeEqual } = crypto;
export const BunCryptoHasher = runtime.CryptoHasher;
export const runtimeProcess = processModule.default;
