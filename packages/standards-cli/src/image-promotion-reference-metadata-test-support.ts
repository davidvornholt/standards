import { isDeepStrictEqual } from 'node:util';
import { yamlContract } from './image-promotion-reference-contract-test-support';
import {
  isLegacyAppState,
  isValidAppState,
} from './image-promotion-reference-state-test-support';
import type {
  AppState,
  Metadata,
} from './image-promotion-reference-test-support';

type MetadataContract = {
  readonly disabledPin: {
    readonly digest: null;
    readonly promotedSourceSha: null;
    readonly promotionEnabled: false;
  };
  readonly imagesPath: string;
  readonly metadataFields: ReadonlyArray<keyof Metadata>;
  readonly operations: Readonly<
    Record<
      | 'accessMigration'
      | 'bootstrap'
      | 'disable'
      | 'metadata'
      | 'pause'
      | 'remove'
      | 'trustedPromotion'
      | 'unpause',
      string
    >
  >;
  readonly pausedField: { readonly promotionPaused: true };
};
export type Images = Readonly<Record<string, unknown>>;
export type MetadataOperation = keyof MetadataContract['operations'];
export const metadataContract = yamlContract<MetadataContract>(
  'metadata-transition',
);

const equal = (left: unknown, right: unknown): boolean =>
  isDeepStrictEqual(left, right);
const metadataOf = (app: AppState): Metadata =>
  Object.fromEntries(
    metadataContract.metadataFields.map((field) => [field, app[field]]),
  ) as Metadata;
const live = (app: unknown): app is AppState =>
  isValidAppState(app) && app.promotionEnabled;
const withoutPause = ({
  promotionPaused: _promotionPaused,
  ...app
}: AppState): AppState => app;
const disabled = (app: unknown): app is AppState =>
  isValidAppState(app) &&
  app.promotionEnabled === metadataContract.disabledPin.promotionEnabled &&
  app.digest === metadataContract.disabledPin.digest &&
  app.promotedSourceSha === metadataContract.disabledPin.promotedSourceSha;
const otherAppsUnchanged = (
  before: Images,
  after: Images,
  app: string,
): boolean => {
  const omit = (images: Images) =>
    Object.fromEntries(Object.entries(images).filter(([name]) => name !== app));
  return equal(omit(before), omit(after));
};

const isPlainRecord = (value: unknown): value is Images =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const allAppsValid = (images: Images): boolean =>
  Object.values(images).every(isValidAppState);

const validAccessMigration = (before: Images, after: Images): boolean => {
  const names = Object.keys(before);
  if (
    !equal(
      [...names].sort((left, right) => left.localeCompare(right)),
      Object.keys(after).sort((left, right) => left.localeCompare(right)),
    )
  ) {
    return false;
  }
  let migrated = false;
  for (const name of names) {
    const current = before[name];
    const next = after[name];
    if (isLegacyAppState(current)) {
      if (!isValidAppState(next)) {
        return false;
      }
      const { registryAccess: _registryAccess, ...finalWithoutAccess } = next;
      if (!equal(current, finalWithoutAccess)) {
        return false;
      }
      migrated = true;
    } else if (!(isValidAppState(current) && equal(current, next))) {
      return false;
    }
  }
  return migrated;
};

type AppTransition = (
  current: unknown,
  next: unknown,
  trustedProof: boolean,
) => boolean;

const appTransitions: Readonly<
  Record<Exclude<MetadataOperation, 'accessMigration'>, AppTransition>
> = {
  bootstrap: (current, next) => current === undefined && disabled(next),
  disable: (current, next) =>
    live(current) &&
    disabled(next) &&
    equal(metadataOf(current), metadataOf(next)),
  metadata: (current, next) =>
    disabled(current) &&
    disabled(next) &&
    !equal(metadataOf(current), metadataOf(next)),
  pause: (current, next) =>
    live(current) &&
    current.promotionPaused === undefined &&
    live(next) &&
    equal(next, { ...current, ...metadataContract.pausedField }),
  remove: (current, next) => disabled(current) && next === undefined,
  trustedPromotion: (current, next, trustedProof) =>
    trustedProof &&
    disabled(current) &&
    live(next) &&
    next.promotionPaused === undefined &&
    typeof next.digest === 'string' &&
    typeof next.promotedSourceSha === 'string' &&
    equal(metadataOf(current), metadataOf(next)),
  unpause: (current, next) =>
    live(current) &&
    current.promotionPaused === true &&
    live(next) &&
    equal(next, withoutPause(current)),
};

export const validMetadataTransition = ({
  after,
  app,
  before,
  changedFiles,
  operation,
  trustedProof,
}: {
  readonly after: unknown;
  readonly app: string;
  readonly before: unknown;
  readonly changedFiles: ReadonlyArray<string>;
  readonly operation: MetadataOperation;
  readonly trustedProof: boolean;
}): boolean => {
  if (
    !(
      equal(changedFiles, [metadataContract.imagesPath]) &&
      isPlainRecord(before) &&
      isPlainRecord(after)
    )
  ) {
    return false;
  }
  if (operation === 'accessMigration') {
    return validAccessMigration(before, after);
  }
  return (
    otherAppsUnchanged(before, after, app) &&
    allAppsValid(before) &&
    allAppsValid(after) &&
    appTransitions[operation](before[app], after[app], trustedProof)
  );
};
