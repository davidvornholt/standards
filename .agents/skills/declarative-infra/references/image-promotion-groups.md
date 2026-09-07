# Coordinated image releases

Use a release group when images from one source repository share a release boundary, such as a UI and worker that share a database and API. Grouped promotion is required once the infrastructure owner declares that boundary. It is not required for unrelated applications.

## Declaration and proof

Keep group membership in a reviewed infrastructure-owned manifest alongside `images.json`. A group has one primary app and a nonempty set of unique members that includes that primary. Every member exists in `images.json`, belongs to at most one group, and has a distinct image repository. All members share the source repository, ref, authorized workflow, enablement state, and promoted source SHA. Validate the whole document before using any member. Membership and source metadata changes use the disabled metadata transition for the whole group.

For example, `{"mail-ui":["mail-ui","mail-worker"]}` declares `mail-ui` as the announcement entrypoint. A companion cannot independently request promotion. The trusted writer reads membership from its trusted base, never from an announcement or candidate branch.

One successful source push run builds all members from the same source commit. Its unique successful build job emits one immutable `IMAGE_PROMOTION_RECORD` per member. Announce only after the entire source workflow has completed successfully. The infrastructure verifier authenticates the configured workflow and run, normalizes its build log, and requires exactly the declared set of records. Every record must bind the same repository, ref, source SHA, and run ID to its configured image and a valid digest. Missing, duplicate, additional, or conflicting records reject the whole candidate. Prove registry access independently for every member.

The primary announcement supplies the existing scalar payload. Companion digests come exclusively from the verified records. A primary identity is bound to the complete proven member-to-digest map. Repeated announcements may add successful run evidence only when that map is identical. A different companion digest is a conflicting release, even when the primary digest is unchanged; reject it and publish a new source commit.

## Desired state and lifecycle

The trusted writer updates every member's digest and source SHA in one infrastructure PR. An unchanged member digest is allowed, but its source SHA must still record the new coordinated release. The provenance gate compares the whole group against the exact proof and rejects partial transitions, unrelated app changes, or metadata edits. The PR changes only `images.json`.

Apply duplicate detection, branch reuse, terminal supersession, current-main ancestry, and rollback to the whole group. Comparing only the primary pin cannot prove a duplicate. Reusing an existing branch requires its complete group map to match. A superseded group operation cannot be reopened through a companion announcement. A rollback selects and verifies the whole previous release as a new approved operation.

## Deployment boundary

A single PR prevents inconsistent desired pins; it does not make container replacement atomic. Choose and document a rollout that respects the application's compatibility boundary. If old and new processes cannot safely share the database or API, stop every group member before migration, run migrations from the selected release, and restart the complete group. Otherwise explicitly establish compatibility across the transition. Do not claim that grouped pins alone prevent temporarily mixed running versions.

Pre-pull and verify all group images before stopping services. Migration failure stops the rollout and leaves completion failed. Do not restart an old member against a changed database without a separately approved recovery decision.

Completion requires the exact infrastructure merge SHA and deploy attempt, matching image readback and health for every member, and successful shared migrations and infrastructure postconditions. A healthy UI with a failed or old worker is incomplete. Record that result on the coordinated PR with a link to the deployment evidence.
