# Vendor image updates

This covers third-party containers whose publisher the infrastructure owner does not control. First-party apps use [App releases](app-release.md). Every update is a reviewed, digest-pinned manifest change deployed with the host.

## Manifest

- The infra repo owns a strict manifest holding, per release family, the approved image repositories, tag or version policy, release-notes URL, selected version, and per-image digest. Reject unknown fields, malformed references, duplicate ownership, and credentials.
- Derive every deployed reference only from the manifest, as `repository@sha256:digest`, and pin each image in exactly one place.
- Prefer the official publisher. A fork you own is still a vendor image. It needs a documented concrete reason, such as a server customization, and an owner who keeps it current.
- Changing publishers is a reviewed change; check runtime, migration, and data-format compatibility first.
- Existing production pins may be adopted unchanged; show that the evaluated container references stay the same.

## Discovery and review

- A trusted scheduled or manual workflow discovers versions only within the approved repositories and tag policy. Prefer stable release tags; if upstream has only a moving tag, record that and resolve it to a digest per proposal.
- Supported registries are public GHCR and Docker Hub. Normalize Docker Hub names only for registry requests. Use anonymous pull-scoped tokens, keep pagination on the same registry and repository, bound requests, and validate returned digests.
- Resolve every family member before writing anything. A registry error, missing member, invalid version, or ambiguous selection fails discovery; never write a partial update or report a successful no-op.
- The updater opens a manifest-only PR with the previous and proposed references, version, publisher, and release notes. Its candidate identity includes the full repository-to-digest map. Reruns reuse the open candidate; a closed one stays closed.
- Never run vendor source or image contents in a workflow that holds a write token.
- Review authorizes the publisher and release; a pullable image proves neither authenticity nor compatibility. Verify signatures or attestations when the publisher policy requires them, and review migrations and backups for data-bearing upgrades.
- There is no automatic merge, scheduled drift detector, or deployment deadline. Adding automatic merge later needs its own explicit release policy. A new version is informational until merged. Report failed discovery separately from failed deployment.

## Superseding older candidates

- A verified candidate (approved publishers, allowed version, digests for every member) retires every other trusted open candidate for its family whose release is provably older, without waiting for its own CI, merge, or deployment.
- Close an older PR only when both PRs have the trusted updater as author, the same-repository canonical branch and identity, and manifest-only changes to that family, with the same members, publisher repositories, and version policy. Leave every other PR open.
- The publisher defines newer. Compare versions under the declared policy. For a moving tag, the release it points at now is newest: resolve it in the same run and require the newer candidate's digest for every member.
- PR numbers, timestamps, discovery order, and digest differences prove nothing. Equal versions with different digests, publisher or family changes, and other incomparable candidates close nothing. Do not use source-commit ancestry.
- Close through the updater and link the replacement. Reruns retry unfinished retirement; report a failed closure or verification as a failure.
- A retired candidate is terminal: reruns do not recreate it, and merge and deployment gates reject it even if reopened. Repair or retry a failing newer candidate, or propose a newer one.
- Cover every rule in this section with updater tests, including that a failed newer release or a manual reopen cannot reactivate a retired candidate.

## Release families and deployment

- Images published as one vendor release, such as Immich server and machine learning, are one family: same upstream version, one PR. A separately versioned database or cache is its own family unless upstream declares a joint version. Members need not share a source SHA or Actions run.
- Rollout is sequential. Establish mixed-version compatibility or stop the family before shared migrations; a failed required member or migration fails the deployment.
- Deploy through the host repo's serialized main-branch pipeline. It requires the quality gate for the exact merge commit, rejects retired candidates, and checks that every digest resolves before changing anything. A run whose commit is no longer main applies nothing and reports superseded, neither complete nor failed.
- Completion means every affected image's runtime digest and health plus all required postconditions on every changed host, for the exact merged PR, merge SHA, and deployment attempt. A merge, a pull, or another commit's deployment is no proof. Attach the result and an evidence link to the PR.
- Roll back with a new reviewed manifest change to verified old digests, deciding database recovery where needed. Never move a tag or reopen a closed candidate to bypass review.
