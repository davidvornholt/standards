# Review decisions

## STRUCTURE-001: Consumer workspace versions

Every workspace in a standards consumer is internal and must use version `0.0.0`. Versioned publishable workspaces are outside the consumer structure contract because consumers do not expose workspace packages as independently released artifacts.

## STRUCTURE-002: Supported workspace declarations

Workspace declarations must be arrays of literal paths or one-level `<dir>/*` patterns. Broader Bun glob patterns and object-shaped workspace schemas are rejected explicitly because the structure gate intentionally supports a small, deterministic consumer layout contract.

## SYNC-001: Checked-in sync policy hard cutover

Starting with CLI 0.7.0, `sync-standards.local.json` is the only standards-sync cadence and ref policy source. The canonical workflow and CLI do not consult `STANDARDS_AUTO_SYNC` or `STANDARDS_SYNC_REF`; consumers must upgrade the package and lockfile and materialize any required policy in the same migration change.

## DEPENDABOT-001: Deliberately lean local overlay

The repo-owned Dependabot overlay is additive but intentionally not a general policy override. It may define new ecosystem update blocks, top-level private registries, and `ignore` or `registries` additions on a canonical normalized target. Matching blocks reject labels, groups, cooldowns, pull-request limits, and every other policy key; broader per-repository policy must be proposed as an explicit seam decision.

## POLLER-001: Shared service identity risk

The fix poller and its approved Codex runs may share one host service identity and HOME. The poller removes its direct GitHub token variables before launching Codex, but the approved run can still read that identity's other ambient credentials and logged-in tool state. This credential visibility is an accepted risk because only an admin- or maintain-approved exact issue revision or pull-request head may run, and the approval binding is revalidated before publication. The host infrastructure repository owns the identity, PATH, token wiring, lingering, and declarative unit deployment; do not describe the Codex process as credential-isolated.

## RELEASE-001: Installed manifest version asserts CLI capability

Under the frozen non-hostile-consumer threat model, the installed `@davidvornholt/standards` manifest version plus the frozen lockfile is the capability assertion. The consumer already controls that dependency and executes its code, so extra package-name, bin, or capability probes do not establish official identity; defending against a falsely versioned or malicious substitution is out of scope.

## TOOLING-001: Root-owned Biome pin

`@biomejs/biome` is pinned only at the repository root (and `template/package.json` for consumers); workspaces deliberately do not declare it. Workspace lint scripts resolve the root-hoisted Biome executable, while `packages/standards-cli/src/template-biome.test.ts` invokes that executable by its root path; a missing install fails at invocation. Reviews must not request per-workspace `@biomejs/biome` declarations; the pin moves with the root/template dependency-hold policy.

## GITHUB-SETTINGS-001: One read-only settings PAT

The isolated GitHub settings job uses one repository-scoped fine-grained PAT with read-only Administration and Issues access. Issues read exposes private issue content beyond the declared-label metadata the checker needs, but that read-only expansion is an accepted tradeoff to keep one credential route instead of adding a second token-selection mechanism. The acceptance depends on the PAT remaining repository-scoped, SOPS-encrypted, isolated from repository-controlled executable code, and free of write permissions. A private-repository probe on PR #94 confirmed that an Administration-plus-Metadata PAT can read merge settings through GraphQL but receives `FORBIDDEN` for `repository.labels`, so GraphQL does not provide a Metadata-only label path; revisit this decision if GitHub changes that permission boundary.

## WORKFLOW-ACTIONS-001: Major-version action tags

Production workflows use maintained major-version tags for external actions instead of full commit SHAs. The owner accepts the minimal risk that an upstream tag could be retargeted; reviews must not request immutable action pins unless that risk assessment changes.

## CREDS-CUSTODY-001: Machine-global plaintext broker custody

The broker store is machine-global state outside every repository, so the repository rule requiring secret values in SOPS-encrypted YAML does not govern it. Plaintext `0600` custody shares the same local-account trust root as the plaintext personal age identity at `~/.config/sops/age/keys.txt`; encrypting the store to a recipient whose private key sits beside it was rejected as theater. Store writes must remain crash-atomic and concurrency-safe so interrupted or simultaneous logins cannot corrupt the file or lose one provider's credential. Reopen this decision if the threat model expands beyond the trusted local account, hardware-backed custody becomes part of the design, or the store moves into a repository, sync, or backup boundary.

## CREDS-GITHUB-001: One global broker GitHub App

One machine-global broker GitHub App and its cross-repository compromise radius are accepted for now: a repository that receives the App key can authenticate as that App against its other installations. Installation on selected repositories is the binding boundary, never an instruction to install on all repositories. Per-purpose Apps with narrower permission ceilings are the designed blast-radius reduction and a supported follow-up once the broker gains multi-App custody; they are not required for the initial single-App broker. Reopen this decision if selected-repository installation no longer contains the intended trust domain, unrelated recipients must not share App authority, the App's permission ceiling broadens materially, or multi-App isolation becomes an immediate requirement.

## CREDS-CLOUDFLARE-001: Two-source Cloudflare reconciliation

Cloudflare reconciliation has exactly two sources of truth: the plaintext SOPS key structure in git and the provider token list under deterministic broker names. A third checked-in credential manifest is deliberately rejected. The absence of a desired-policy record means live policy drift is accepted as out of scope while the bootstrap token remains uncompromised; provider policy remains inspectable. A repository rename or transfer changes the deterministic namespace and is a documented human-visible re-mint-and-revoke event, not a reason to add persistent identity. This acceptance does not relax lifecycle invariants: login must functionally prove token-list authority, inactive tokens must not count as healthy, renewal must create a fresh-expiry replacement from the live policy, durably write and verify its value, then revoke the old token, and account-only minting must reject zone-scoped permission groups without a zone resource. Reopen this decision if policy-drift enforcement becomes required, bootstrap-token compromise enters the threat model, renames or transfers must reconcile automatically, or the two sources can no longer identify managed credentials unambiguously.

## STANDARDS-CLI-001: Effect-free bootstrap package

`packages/standards-cli` is deliberately plain TypeScript rather than Effect because its published bin must run through `bunx` before a consumer has installed any project dependencies. The package keeps a minimal runtime dependency surface (currently only `yaml`) and uses its established async/error idiom consistently; the credential broker follows the same package-level exception to the root Effect standards. Do not add Effect merely to align this bootstrap package with application architecture. Reopen this decision if the CLI no longer needs to bootstrap dependency-free consumers, its runtime is split into a separately installed package, or the minimal-dependency premise otherwise changes.
