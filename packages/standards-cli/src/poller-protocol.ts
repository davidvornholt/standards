// The fix-poller protocol: every piece of workflow state is a GitHub label,
// comment, or draft PR, so any tick — on any host — can resume from GitHub
// alone. Labels are declared in the canonical .github/settings.json, so
// consumers receive the protocol via `standards github --apply`.

export const APPROVED_FOR_FIX = 'approved-for-fix';
export const FIX_IN_PROGRESS = 'fix-in-progress';
export const FIX_FAILED = 'fix-failed';
export const APPROVED_FOR_REVIEW = 'approved-for-review';
export const REVIEW_IN_PROGRESS = 'review-in-progress';
export const REVIEW_FAILED = 'review-failed';
export const NEEDS_CLARIFICATION = 'needs-clarification';
export const DEFERRED_FINDING = 'deferred-finding';

// Poller-authored comments carry a marker so a later tick can tell its own
// questions and failure reports apart from human conversation.
export const QUESTION_MARKER = '<!-- standards-poller:question -->';
export const FAILURE_MARKER = '<!-- standards-poller:failure -->';
export const CLAIM_MARKER = '<!-- standards-poller:claim -->';
export const FIX_OUTPUT_MARKER = 'standards-poller:fix-output';

// Repository roles trusted to approve automation and answer its questions.
// GitHub already restricts labeling to triage+, but the poller re-verifies the
// acting user so a mis-granted triage role cannot drive code changes.
const TRUSTED_ROLES: ReadonlySet<string> = new Set(['admin', 'maintain']);

export const isTrustedRole = (role: string): boolean => TRUSTED_ROLES.has(role);

// Structured handoff from a Codex run back to the poller. A file instead of
// stdout parsing: agent stdout is unreliable once tools are active, and the
// poller must verify effects, not trust narration.
export const OUTCOME_DIR = '.standards-poller';
export const OUTCOME_FILE = '.standards-poller/outcome.json';

export type FixOutcome = {
  readonly status: 'fixed' | 'question' | 'stale' | 'cannot-fix';
  readonly summary: string;
  readonly question?: string;
  readonly prTitle?: string;
  readonly prBody?: string;
};

export type DeferredFinding = {
  readonly title: string;
  readonly body: string;
};

export type ReviewOutcome = {
  readonly status: 'reviewed' | 'question' | 'cannot-review';
  readonly summary: string;
  readonly question?: string;
  readonly report?: string;
  readonly deferred?: ReadonlyArray<DeferredFinding>;
};

// Paths the automation must never modify in a consumer repository. Canonical
// synced files come from the repo's own sync-standards.lock; the rest are the
// classes AGENTS.md marks propose-only (CI workflows, quality-gate wiring)
// or secret (any non-example SOPS target, wherever it lives).
const GATE_WIRING_FILES: ReadonlySet<string> = new Set([
  'biome.jsonc',
  'turbo.json',
  'package.json',
]);

const HOST_SECRETS_FILE = /(?:^|\/)secrets\.yaml$/u;
const WORKSPACE_GATE_CONFIG =
  /(?:^|\/)(?:biome\.jsonc|turbo\.json|tsconfig(?:\.[^.]+)?\.json|vitest\.config\.[cm]?[jt]s|playwright\.config\.[cm]?[jt]s)$/u;
const QUALITY_SCRIPT = /^(?:check|lint|test|typecheck)(?::|$)/u;
const WORKSPACE_MANIFEST = /^(?:apps|packages)\/[^/]+\/package\.json$/u;
const APPROVAL_ID_LENGTH = 12;

const isEncryptedSecret = (path: string): boolean =>
  !path.endsWith('.example.yaml') &&
  (path.startsWith('secrets/') || HOST_SECRETS_FILE.test(path));

export const forbiddenDiffPaths = (
  changedPaths: ReadonlyArray<string>,
  lockedPaths: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const locked = new Set(lockedPaths);
  return changedPaths.filter(
    (path) =>
      locked.has(path) ||
      path === 'sync-standards.lock' ||
      path.startsWith('.github/workflows/') ||
      GATE_WIRING_FILES.has(path) ||
      WORKSPACE_GATE_CONFIG.test(path) ||
      isEncryptedSecret(path) ||
      path === OUTCOME_FILE ||
      path.startsWith(`${OUTCOME_DIR}/`),
  );
};

const qualityScripts = (
  manifest: unknown,
): Readonly<Record<string, string>> => {
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('scripts' in manifest) ||
    typeof manifest.scripts !== 'object' ||
    manifest.scripts === null
  ) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(manifest.scripts)
      .filter(
        (entry): entry is [string, string] =>
          QUALITY_SCRIPT.test(entry[0]) && typeof entry[1] === 'string',
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
};

export const changesWorkspaceQualityScripts = (
  path: string,
  before: string,
  after: string,
): boolean => {
  if (path === 'package.json' || !WORKSPACE_MANIFEST.test(path)) {
    return false;
  }
  try {
    return (
      JSON.stringify(qualityScripts(JSON.parse(before) as unknown)) !==
      JSON.stringify(qualityScripts(JSON.parse(after) as unknown))
    );
  } catch {
    return true;
  }
};

export const branchNameForIssue = (
  issueNumber: number,
  approvalId: string,
): string =>
  `poller/fix-issue-${issueNumber}-${approvalId.slice(0, APPROVAL_ID_LENGTH)}`;
