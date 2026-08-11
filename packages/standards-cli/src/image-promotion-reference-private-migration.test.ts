import { expect, it } from 'bun:test';
import { yamlContract } from './image-promotion-reference-contract-test-support';

type MigrationContract = {
  readonly appliesTo: ReadonlyArray<string>;
  readonly stages: {
    readonly plumbing: {
      readonly allowedAppState: string;
      readonly privatePrePull: string;
      readonly requiredReadback: ReadonlyArray<string>;
    };
    readonly privatePromotion: {
      readonly allowedAppState: string;
      readonly privatePrePull: string;
      readonly requires: string;
    };
  };
};

type MigrationState = {
  readonly appState: 'disabled' | 'private' | 'public';
  readonly plumbingReadback: boolean;
};

const migration = yamlContract<MigrationContract>('private-host-migration');

const installPlumbing = (state: MigrationState): MigrationState | null => {
  const allowed =
    migration.stages.plumbing.allowedAppState === 'disabled-or-public' &&
    ['disabled', 'public'].includes(state.appState);
  if (!(allowed && migration.stages.plumbing.privatePrePull === 'forbidden')) {
    return null;
  }
  return { ...state, plumbingReadback: true };
};

const promotePrivate = (state: MigrationState): boolean =>
  migration.stages.privatePromotion.requires === 'plumbing-readback' &&
  state.plumbingReadback &&
  migration.stages.privatePromotion.allowedAppState === state.appState &&
  migration.stages.privatePromotion.privatePrePull === 'required';

it('requires plumbing readback before a new disabled private app promotes', () => {
  const adopted: MigrationState = {
    appState: 'disabled',
    plumbingReadback: false,
  };
  expect(promotePrivate({ ...adopted, appState: 'private' })).toBeFalse();
  const bootstrapped = installPlumbing(adopted);
  expect(bootstrapped).not.toBeNull();
  expect(
    promotePrivate({
      ...(bootstrapped as MigrationState),
      appState: 'private',
    }),
  ).toBeTrue();
});

it('installs plumbing while public before a public-to-private migration', () => {
  const publicApp: MigrationState = {
    appState: 'public',
    plumbingReadback: false,
  };
  expect(promotePrivate({ ...publicApp, appState: 'private' })).toBeFalse();
  const bootstrapped = installPlumbing(publicApp);
  expect(bootstrapped).not.toBeNull();
  expect(
    promotePrivate({
      ...(bootstrapped as MigrationState),
      appState: 'private',
    }),
  ).toBeTrue();
  expect(
    installPlumbing({ appState: 'private', plumbingReadback: false }),
  ).toBeNull();
});

it('declares readback of every credential-plumbing component', () => {
  expect(migration.appliesTo).toEqual([
    'new-private-adoption',
    'public-to-private-migration',
  ]);
  expect(migration.stages.plumbing.requiredReadback).toEqual([
    'sops-secret',
    'login-unit-success',
    'private-auth-file',
  ]);
});
