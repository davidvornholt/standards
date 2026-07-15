export const SYNC_LOCK_FILE = 'sync-standards.lock';

export const TRANSACTION_DIRECTORY = '.standards-transaction';
export const TRANSACTION_CLEANUP = '.standards-transaction-cleanup';
export const TRANSACTION_JOURNAL = 'journal.json';
export const TRANSACTION_JOURNAL_TEMP = 'journal.json.tmp';
export const TRANSACTION_OWNER = 'OWNER';
export const TRANSACTION_OWNER_RESERVATION =
  '.standards-transaction-owner-reservation';
export const TRANSACTION_OWNER_PUBLICATION_PREFIX =
  '.standards-owner-publication-';
export const TRANSACTION_PARENT_PREFIX = '.standards-parent-';
export const TRANSACTION_PARENT_BINDING_PREFIX = `${TRANSACTION_PARENT_PREFIX}binding-`;
export const TRANSACTION_PUBLICATION_PREFIX =
  '.standards-transaction-publication-';
export const TRANSACTION_RESERVATION = '.standards-transaction-reservation';
export const TRANSACTION_COMMITTED = 'COMMITTED';
export const REMOVAL_BINDING_PREFIX = '.standards-removal-';

export const RESERVED_TRANSACTION_ARTIFACT_GRAMMAR = {
  atomicTails: [
    `${TRANSACTION_RESERVATION}.<uuid-v4>.tmp`,
    `${TRANSACTION_OWNER}.<uuid-v4>.tmp`,
    `${TRANSACTION_PARENT_BINDING_PREFIX}<transaction-uuid-v4>-<index>.<write-uuid-v4>.tmp`,
  ],
  fixedNames: [
    TRANSACTION_DIRECTORY,
    TRANSACTION_CLEANUP,
    TRANSACTION_OWNER_RESERVATION,
    TRANSACTION_RESERVATION,
  ],
  prefixFamilies: [
    `${TRANSACTION_PUBLICATION_PREFIX}*`,
    `${TRANSACTION_OWNER_PUBLICATION_PREFIX}*`,
    `${TRANSACTION_PARENT_PREFIX}*`,
    `${REMOVAL_BINDING_PREFIX}*`,
  ],
} as const;

const GITIGNORE_HEX = '[0-9a-f]';
const GITIGNORE_THREE_HEX = `${GITIGNORE_HEX}${GITIGNORE_HEX}${GITIGNORE_HEX}`;
const GITIGNORE_FOUR_HEX = `${GITIGNORE_THREE_HEX}${GITIGNORE_HEX}`;
const GITIGNORE_EIGHT_HEX = `${GITIGNORE_FOUR_HEX}${GITIGNORE_FOUR_HEX}`;
const GITIGNORE_TWELVE_HEX = `${GITIGNORE_EIGHT_HEX}${GITIGNORE_FOUR_HEX}`;
const UUID_V4_GITIGNORE = `${GITIGNORE_EIGHT_HEX}-${GITIGNORE_FOUR_HEX}-4${GITIGNORE_THREE_HEX}-[89ab]${GITIGNORE_THREE_HEX}-${GITIGNORE_TWELVE_HEX}`;

export const GIT_RECOVERY_ARTIFACT_EXCLUDES = [
  ...RESERVED_TRANSACTION_ARTIFACT_GRAMMAR.fixedNames,
  `${TRANSACTION_RESERVATION}.${UUID_V4_GITIGNORE}.tmp`,
  `${TRANSACTION_OWNER}.${UUID_V4_GITIGNORE}.tmp`,
  ...RESERVED_TRANSACTION_ARTIFACT_GRAMMAR.prefixFamilies,
] as const;
