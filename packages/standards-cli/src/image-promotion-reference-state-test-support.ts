import type {
  AppState,
  Metadata,
} from './image-promotion-reference-test-support';

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const GHCR_REPOSITORY =
  /^ghcr\.io\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u;
const SOURCE_REF = /^refs\/heads\/[^\s]+$/u;
const SOURCE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const TRACKED_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u;

const metadataKeys = [
  'imageRepository',
  'promotionLatencyMinutes',
  'registryAccess',
  'sourceRef',
  'sourceRepository',
  'sourceWorkflow',
  'trackedTag',
] as const;
const pinKeys = ['digest', 'promotedSourceSha', 'promotionEnabled'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
};

const hasValidMetadataValues = (
  value: Record<string, unknown>,
  allowMissingRegistryAccess: boolean,
): boolean => {
  const workflow = value.sourceWorkflow;
  return (
    typeof value.imageRepository === 'string' &&
    GHCR_REPOSITORY.test(value.imageRepository) &&
    Number.isSafeInteger(value.promotionLatencyMinutes) &&
    Number(value.promotionLatencyMinutes) > 0 &&
    (allowMissingRegistryAccess ||
      value.registryAccess === 'public' ||
      value.registryAccess === 'private') &&
    typeof value.sourceRef === 'string' &&
    SOURCE_REF.test(value.sourceRef) &&
    typeof value.sourceRepository === 'string' &&
    SOURCE_REPOSITORY.test(value.sourceRepository) &&
    isRecord(workflow) &&
    hasExactKeys(workflow, ['id', 'path']) &&
    Number.isSafeInteger(workflow.id) &&
    Number(workflow.id) > 0 &&
    typeof workflow.path === 'string' &&
    workflow.path.startsWith('.github/workflows/') &&
    typeof value.trackedTag === 'string' &&
    TRACKED_TAG.test(value.trackedTag)
  );
};

const hasValidPins = (value: Record<string, unknown>): boolean => {
  if (value.promotionEnabled === false) {
    return value.digest === null && value.promotedSourceSha === null;
  }
  return (
    value.promotionEnabled === true &&
    typeof value.digest === 'string' &&
    DIGEST.test(value.digest) &&
    typeof value.promotedSourceSha === 'string' &&
    SOURCE_SHA.test(value.promotedSourceSha)
  );
};

const validAppState = (
  value: unknown,
  allowMissingRegistryAccess: boolean,
): boolean => {
  if (!isRecord(value)) {
    return false;
  }
  const expectedMetadata = allowMissingRegistryAccess
    ? metadataKeys.filter((key) => key !== 'registryAccess')
    : metadataKeys;
  return (
    hasExactKeys(value, [...expectedMetadata, ...pinKeys]) &&
    hasValidMetadataValues(value, allowMissingRegistryAccess) &&
    hasValidPins(value)
  );
};

export const isValidAppState = (value: unknown): value is AppState =>
  validAppState(value, false);

export const isLegacyAppState = (
  value: unknown,
): value is Omit<AppState, 'registryAccess'> => validAppState(value, true);

export const metadataWithoutRegistryAccess = (
  value: Metadata,
): Omit<Metadata, 'registryAccess'> => {
  const { registryAccess: _registryAccess, ...legacy } = value;
  return legacy;
};
