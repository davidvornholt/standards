import { LOCAL_SETTINGS_FILE } from './github-api';
import { SYNC_POLICY_FILE } from './sync-policy';
import { isReservedTransactionPath } from './sync-transaction-artifact-names';

export const REPOSITORY_OWNED_CONTROL_SEAMS = [
  LOCAL_SETTINGS_FILE,
  'AGENTS.local.md',
  'biome.jsonc',
  SYNC_POLICY_FILE,
] as const;

export const SYNC_LOCK_FILE = 'sync-standards.lock';

export type ReservedSyncTarget = {
  readonly kind:
    | 'CLI-owned lock'
    | 'CLI-owned transaction namespace'
    | 'repository-owned control seam';
  readonly target: string;
};

const isUnder = (path: string, parent: string): boolean =>
  path === parent || path.startsWith(`${parent}/`);

export const classifyReservedSyncTarget = (
  path: string,
): ReservedSyncTarget | null => {
  if (isReservedTransactionPath(path)) {
    return { kind: 'CLI-owned transaction namespace', target: path };
  }
  if (isUnder(path, SYNC_LOCK_FILE) || isUnder(SYNC_LOCK_FILE, path)) {
    return { kind: 'CLI-owned lock', target: SYNC_LOCK_FILE };
  }
  const seam = REPOSITORY_OWNED_CONTROL_SEAMS.find(
    (candidate) => isUnder(path, candidate) || isUnder(candidate, path),
  );
  return seam === undefined
    ? null
    : { kind: 'repository-owned control seam', target: seam };
};
