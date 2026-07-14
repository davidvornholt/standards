import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { inspectRepositoryNode, type RepositoryRoot } from './sync-filesystem';

type MountEntry = {
  readonly id: number;
  readonly mountPoint: string;
};

type MountLocation = {
  readonly kind: 'parent' | 'target';
  readonly path: string;
  readonly rel: string;
};

const DECIMAL = /^\d+$/u;
const DEVICE = /^\d+:\d+$/u;
const MOUNT_ESCAPE = /\\(?:011|012|040|134)/gu;
const REQUIRED_PREFIX_FIELDS = 6;
const REQUIRED_SUFFIX_FIELDS = 3;

const decodeMountPath = (value: string): string => {
  if (value.replaceAll(MOUNT_ESCAPE, '').includes('\\')) {
    throw new Error('Linux mountinfo contains an invalid path escape');
  }
  return value.replaceAll(MOUNT_ESCAPE, (encoded) =>
    String.fromCodePoint(Number.parseInt(encoded.slice(1), 8)),
  );
};

const parseMountEntry = (line: string, lineNumber: number): MountEntry => {
  const fields = line.split(' ');
  const [idField, parentField, device, , mountPoint, options] = fields;
  const separator = fields.findIndex(
    (field, index) => index >= REQUIRED_PREFIX_FIELDS && field === '-',
  );
  const optionalFields = fields.slice(REQUIRED_PREFIX_FIELDS, separator);
  const suffix = separator < 0 ? [] : fields.slice(separator + 1);
  const id = Number(idField);
  const parentId = Number(parentField);
  const deviceParts = device?.split(':').map(Number) ?? [];
  const checks: ReadonlyArray<readonly [string, boolean]> = [
    ['fields-nonempty', fields.every((field) => field.length > 0)],
    ['id-syntax', idField !== undefined && DECIMAL.test(idField)],
    ['id-range', Number.isSafeInteger(id) && id > 0],
    ['parent-syntax', parentField !== undefined && DECIMAL.test(parentField)],
    ['parent-range', Number.isSafeInteger(parentId) && parentId >= 0],
    ['device-syntax', device !== undefined && DEVICE.test(device)],
    ['device-range', deviceParts.every(Number.isSafeInteger)],
    ['mount-point-path', mountPoint?.startsWith('/') === true],
    ['options', options !== undefined && options.length > 0],
    ['separator', separator >= REQUIRED_PREFIX_FIELDS],
    ['optional-fields', optionalFields.every((field) => field.length > 0)],
    ['suffix-count', suffix.length === REQUIRED_SUFFIX_FIELDS],
    ['suffix-fields', suffix.every((field) => field.length > 0)],
  ];
  const failed = checks
    .filter(([, valid]) => !valid)
    .map(([name]) => name)
    .join(',');
  if (failed.length > 0) {
    throw new Error(
      `Linux mountinfo contains an invalid mount entry at line ${lineNumber} (fields=${fields.length}, separator=${separator}, suffix=${suffix.length}; failed=${failed})`,
    );
  }
  return { id, mountPoint: decodeMountPath(mountPoint) };
};

export const parseMountInfo = (contents: string): ReadonlyArray<MountEntry> =>
  contents
    .split('\n')
    .flatMap((line, lineIndex) =>
      line.length === 0 ? [] : [parseMountEntry(line, lineIndex + 1)],
    );

const containsPath = (mountPoint: string, path: string): boolean =>
  mountPoint === '/' ||
  path === mountPoint ||
  path.startsWith(`${mountPoint}${sep}`);

export const mountIdForPath = (
  path: string,
  entries: ReadonlyArray<MountEntry>,
): number => {
  const absolute = resolve(path);
  const match = entries
    .filter(({ mountPoint }) => containsPath(mountPoint, absolute))
    .sort((left, right) => left.mountPoint.length - right.mountPoint.length)
    .at(-1);
  if (match === undefined) {
    throw new Error(`Linux mountinfo does not cover filesystem path: ${path}`);
  }
  return match.id;
};

const nearestExistingParent = async (
  root: RepositoryRoot,
  rel: string,
): Promise<MountLocation> => {
  let parent = dirname(rel);
  while (parent !== '.') {
    // Search is intentionally leaf-to-root so the closest mount boundary wins.
    // biome-ignore lint/performance/noAwaitInLoops: nearest-parent ordering is the preflight contract
    const node = await inspectRepositoryNode(root, parent);
    if (node.info !== null) {
      if (!node.info.isDirectory()) {
        throw new Error(
          `${root.label} parent component must be a directory: ${parent}`,
        );
      }
      return { kind: 'parent', path: node.path, rel: parent };
    }
    parent = dirname(parent);
  }
  return { kind: 'parent', path: root.path, rel: '.' };
};

const mountLocations = async (
  root: RepositoryRoot,
  rel: string,
): Promise<ReadonlyArray<MountLocation>> => {
  const [target, parent] = await Promise.all([
    inspectRepositoryNode(root, rel),
    nearestExistingParent(root, rel),
  ]);
  return target.info === null
    ? [parent]
    : [parent, { kind: 'target', path: target.path, rel }];
};

export const assertPlanSingleFilesystem = async (
  root: RepositoryRoot,
  rels: ReadonlyArray<string>,
): Promise<void> => {
  const [mountInfo, nested] = await Promise.all([
    readFile('/proc/self/mountinfo', 'utf8'),
    Promise.all([...new Set(rels)].map((rel) => mountLocations(root, rel))),
  ]);
  const entries = parseMountInfo(mountInfo);
  const rootMount = mountIdForPath(root.path, entries);
  const foreign = nested
    .flat()
    .filter(({ path }) => mountIdForPath(path, entries) !== rootMount)
    .map(({ kind, rel }) => `${kind}: ${rel}`);
  const unique: ReadonlyArray<string> = [...new Set(foreign)];
  if (unique.length > 0) {
    throw new Error(
      `Transaction target crosses a filesystem boundary at ${unique.map(String).join(', ')}`,
    );
  }
};
