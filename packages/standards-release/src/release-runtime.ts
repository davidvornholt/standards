type RuntimeProcess = {
  exitCode: number | undefined;
};

// Dynamic loading avoids a Biome 2.5.3 resolver failure on Bun's static exports and isolates the Node-compatible process edge in this private runtime adapter.
const runtime = await import('bun');
const fileSystem = await import(['node', 'fs/promises'].join(':'));
const processModule = (await import(['node', 'process'].join(':'))) as {
  readonly default: RuntimeProcess;
};

export const { argv, env, file, spawn, stderr, write } = runtime;
export const nodeWriteFile = fileSystem.writeFile;
export const BunCryptoHasher = runtime.CryptoHasher;
export const runtimeProcess = processModule.default;
