import { LOCAL_SETTINGS_FILE } from './github-api';
import { SYNC_POLICY_FILE } from './sync-policy';
import {
  TRANSACTION_CLEANUP,
  TRANSACTION_DIRECTORY,
  TRANSACTION_RESERVATION,
} from './sync-transaction-types';

export const REPOSITORY_OWNED_CONTROL_SEAMS = [
  TRANSACTION_CLEANUP,
  TRANSACTION_DIRECTORY,
  TRANSACTION_RESERVATION,
  LOCAL_SETTINGS_FILE,
  'AGENTS.local.md',
  'biome.jsonc',
  SYNC_POLICY_FILE,
] as const;
