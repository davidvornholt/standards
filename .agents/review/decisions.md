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

The fix poller and its approved Codex runs share one host service identity, HOME, and service PAT. Codex therefore inherits the PAT and technically holds all capabilities that credential grants; prompt restrictions and the poller's approval, claim, target, protected-path, and pre-write publication revalidation are workflow safeguards, not credential isolation or a reduced capability boundary. This capability exposure is an accepted risk because only an admin- or maintain-approved exact issue revision or pull-request head may run, while the poller retains commit pushes, protocol labels, final reports, and ready transitions. This finding is explicitly discarded: do not reintroduce token scrubbing as its fix. Reopen the decision if untrusted users can approve runs, the PAT permission or repository scope broadens, agent writes escape their approved repository target, the poller stops revalidating immediately before its writes, or the host threat model begins to require credential isolation. The host infrastructure repository owns the identity, PATH, token wiring, lingering, and declarative unit deployment.

## RELEASE-001: Installed manifest version asserts CLI capability

Under the frozen non-hostile-consumer threat model, the installed `@davidvornholt/standards` manifest version plus the frozen lockfile is the capability assertion. The consumer already controls that dependency and executes its code, so extra package-name, bin, or capability probes do not establish official identity; defending against a falsely versioned or malicious substitution is out of scope.

## RELEASE-002: Standards CLI bootstrap error architecture

`packages/standards-cli` deliberately uses plain TypeScript async code, discriminated result unions, and a minimal runtime dependency surface because its published bin bootstraps dependency-free consumers through `bunx`; adding Effect would either defeat that bootstrap boundary or split the package into two architectures. Reviews may challenge this decision only if the CLI no longer bootstraps dependency-free consumers, its runtime moves to a separately installed package, or the minimal-dependency premise otherwise changes.

## TOOLING-001: Root-owned Biome pin

`@biomejs/biome` is pinned only at the repository root (and `template/package.json` for consumers); workspaces deliberately do not declare it. Workspace lint scripts resolve the root-hoisted Biome executable, while `packages/standards-cli/src/template-biome.test.ts` invokes that executable by its root path; a missing install fails at invocation. Reviews must not request per-workspace `@biomejs/biome` declarations; the pin moves with the root/template dependency-hold policy.

## GITHUB-SETTINGS-001: No durable settings credential

The isolated GitHub settings job verifies with the workflow token and provisions no credential of its own, never a token-selection mechanism. Its grants are `contents: read` and `issues: read`: Issues read exposes private issue content beyond the declared-label metadata the checker needs, and that read-only expansion is an accepted tradeoff, because a private-repository probe on PR #94 confirmed that an Administration-plus-Metadata PAT can read merge settings through GraphQL but receives `FORBIDDEN` for `repository.labels`, so GraphQL offers no Metadata-only label path.

The credential was originally a durable repository-scoped fine-grained PAT stored as `ci.github_settings_read_token`. PR #174 retires it without replacement, in two steps that each rested on a probe against the private `personal-infra` repository. First, minted installation tokens differing only in Administration read answered identically — both listed all three rulesets over REST, both were refused `bypass_actors` and repository merge settings over REST, both received full merge settings and exact bypass-actor counts over GraphQL — so Administration read buys an installation token no visibility the implicit Metadata read already gives it, and it is not requested anywhere, including `DEFAULT_PERMISSIONS`. That is narrower than the Administration-plus-Metadata *user* PAT of the PR #94 probe, and the difference is real: user-scoped tokens do gain ruleset bypass-actor identities from Administration, installation tokens never do. Second, a token holding exactly the settings job's `contents: read` and `issues: read` answered identically to the installation token on all four surfaces as well. A brokered token therefore sees nothing the workflow token does not, so minting one would decrypt the durable App key on every gate run to gain nothing — and the fallback that a broker path needs would silently degrade to the workflow token on a rotated age key, which reads as a green gate rather than a broken one.

What the gate verifies is unchanged, and every fail-closed path stays: state the token cannot see is drift, not a pass. `ci.broker_app` remains required by the weekly sync and is now the only durable GitHub credential a consumer stores. Revisit this decision if GitHub changes the label permission boundary, moves any compared setting behind a permission the workflow token cannot hold, or the settings gate comes to need a read the workflow token cannot be granted — at which point the broker path returns as a fail-closed requirement, not a fallback.

## GITHUB-SETTINGS-002: Ruleset bypass-actor visibility boundary

REST serves ruleset `bypass_actors` only to a user-scoped token holding repository Administration read, while GraphQL answers an exact `bypassActors.totalCount` to tokens it will not let name the actors. A probe on PR #176 against this repository's own `Protect main` ruleset, using a temporary bypass actor since removed, established both halves: admin `gh` auth over REST saw `[{repository_role 5, always}]`; a broker App installation token saw the field absent at its full permission ceiling and again at `administration: read` + `issues: read`; that same installation token over GraphQL saw `totalCount: 1` with `nodes: [null]`. A second reviewer corroborated the non-zero case independently against public repositories with a non-admin classic-scope viewer — `oven-sh/bun` `totalCount: 2` and `vercel/next.js` `totalCount: 4`, both with nulled nodes, against an exact `0` for `microsoft/vscode` — so the count is not visibility-filtered; only the identities are. The count is therefore trusted as exact, which is what makes zero a verifying answer rather than merely an absent one, and the checker cross-checks `totalCount` against the returned `nodes` length on every call so the assumption is checked rather than trusted. The boundary is narrow: a matching non-zero count still says nothing about which actors bypass, so that case fails closed instead of passing. Revisit this decision if GitHub filters `totalCount` by viewer permission, exposes the actor list to installation tokens over REST, or the cross-check begins to fire.

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
