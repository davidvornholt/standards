# Vendor image promotion

Use this contract for third-party containers whose publisher is outside the infrastructure owner's control. Such images require reviewed, immutable desired-state updates and verified deployment completion. They do not require our source announcement workflow or access to the vendor's private Actions logs.

## Publisher and desired state

The infrastructure repository owns a strict manifest with each release family's approved image repositories, allowed tag or version policy, release-notes URL, selected version, and per-image digest. Reject unknown fields, malformed references, duplicate ownership, and credentials. Derive each deployed reference exclusively from this manifest as `repository@sha256:digest`.

Prefer the official upstream publisher. A personal fork needs a documented server customization or another concrete reason, plus responsibility for keeping it current. Repository ownership alone does not turn third-party software into an internally maintained application. Changing publishers is a reviewed metadata change, with runtime, migration, and data-format compatibility checked before deployment.

Existing immutable production pins may be adopted unchanged into the manifest without republishing a vendor build or disabling the application. Show that adoption preserves the evaluated container references. Do not duplicate a pin in both source and vendor manifests.

## Discovery and review

A scheduled or manually invoked trusted workflow discovers versions only within the approved repository and tag policy. Prefer stable release tags when provided. If upstream only publishes a moving tag, record that choice and resolve it to a digest for each proposal. Tag age does not impose a deployment deadline.

This contract covers public GHCR and Docker Hub images. Normalize Docker Hub names for registry requests without changing the declared publisher. Use anonymous pull-scoped registry tokens, restrict pagination to the same registry and repository, bound requests, and validate returned digests. Resolve all release-family members before writing anything. Registry errors, missing members, invalid versions, or ambiguous selection fail discovery; they must not produce a partial update or a successful no-op.

The updater opens a manifest-only PR containing the previous and proposed immutable references, selected version, publisher, and upstream release notes. Its canonical candidate identity includes the complete repository-to-digest map. Reruns reuse the same open candidate; a closed candidate remains closed. A newer candidate can be proposed while an older one is deliberately deferred. Do not execute vendor source or image contents in a workflow holding a write token.

Human review authorizes the publisher and release. Registry availability proves pullability, not authenticity or application compatibility. Verify upstream signatures or attestations when the declared publisher policy requires them. Review migration prerequisites and backups for data-bearing upgrades. Do not enable automatic merge as part of adoption; any later automation requires a separate explicit release policy.

## Release families and deployment

Images published as one vendor release, such as Immich server and machine learning, form a release family. Select the same upstream version for every member and pin them in one PR. A separately versioned database or cache remains a separate family unless upstream declares a joint version contract. Vendor images need not share a source SHA or Actions run.

One PR coordinates desired state, but container rollout remains sequential. Establish mixed-version compatibility or stop the family before shared migrations. Pre-pull every selected digest first and fail the whole deployment when a required member or migration fails.

Use the infrastructure home's exact-commit quality gate, current-main guard, serialized deployment, and pre-mutation registry verification. Completion belongs to the exact merged PR, infrastructure merge SHA, and successful deploy attempt. Require every affected image's runtime digest and health plus all required infrastructure postconditions. A merge, successful pull, or another commit's deployment does not prove completion. Attach a deployment result and evidence link to the original PR.

A rollback is a new reviewed manifest change with verified old digests and an explicit database recovery decision where needed. Never move a tag or reactivate a closed candidate to bypass review.

An available version is informational until approved through merge. Report failed discovery separately from failed deployment. Verify approved images and health during deployment. Do not add a scheduled image drift detector or deployment deadline.
