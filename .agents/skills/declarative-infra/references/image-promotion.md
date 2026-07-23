# Image promotion (source repo to infra home)

When an app's infrastructure home is a dedicated infra repo, deployment freshness is automation-owned: the source repo announces every successful public-image build, and the home repo's trusted writer proposes the desired-state change. Never edit a live pin by hand or treat either PR merge as deployment completion.

**Completion invariant:** a source change is done only when the exact infra merge SHA has passed its fail-closed gate and every required target has returned a healthy readback of the expected digest. A failed or partial activation is incomplete; report it instead of attempting automatic cross-system rollback.

The machine-readable writer, provenance, deploy, completion, and detector examples in [Image promotion contracts](image-promotion-contracts.md) are part of this contract and must be copied with the policy below.

## One desired-state owner

The home repo owns one `images.json` (`infra/images.json`, or root `images.json` in a dedicated infra repo). Announcement validation, the trusted writer, deployment, readback, and drift detection all read its per-app objects:

<!-- contract:images-json -->
```json
{
  "web": {
    "sourceRepository": "example/app",
    "sourceRef": "refs/heads/main",
    "sourceWorkflow": {
      "path": ".github/workflows/build.yml",
      "id": 123456
    },
    "imageRepository": "ghcr.io/example/app/web",
    "trackedTag": "main",
    "promotionLatencyMinutes": 30,
    "promotionEnabled": true,
    "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "promotedSourceSha": "1111111111111111111111111111111111111111"
  }
}
```

`sourceWorkflow.path` and `sourceWorkflow.id` bind the immutable authorized Actions workflow; a different successful workflow with a job named `build` is not evidence. Derive production references only as `imageRepository@digest`. `images.json` is the single declarative state owner being converged, not a third credential ledger of the kind rejected by `CREDS-CLOUDFLARE-001`.

## Source side: bind and announce the build

The trusted build job publishes `imageRepository:trackedTag`, obtains the registry digest, and emits exactly one single-line JSON record to its immutable job log. The marker is assembled from fragments so the full marker cannot appear in the runner's echoed shell source. A separate announcement job runs only after build success. Its fallback token is read-only; its one-infra-repository App token has only Contents write.

The App credentials live at `ci.broker_app.app_id` and `ci.broker_app.private_key` in `secrets/ci.yaml`. Resolve both with the canonical action, which transports nested multiline values through `GITHUB_ENV`, never outputs.

<!-- contract:source-workflow -->
```yaml
permissions: { contents: read }
jobs:
  build:
    permissions: { contents: read, packages: write }
    outputs: { digest: "${{ steps.build.outputs.digest }}" }
    steps:
      - id: build
        uses: docker/build-push-action@v6
        with: { push: true, tags: "ghcr.io/example/app/web:main" }
      - name: Emit immutable promotion record
        env:
          DIGEST: "${{ steps.build.outputs.digest }}"
          IMAGE: ghcr.io/example/app/web
          REF: "${{ github.ref }}"
          REPOSITORY: "${{ github.repository }}"
          RUN_ID: "${{ github.run_id }}"
          SHA: "${{ github.sha }}"
        run: |
          set -euo pipefail
          record=$(jq -cn --arg repository "$REPOSITORY" --arg ref "$REF" --arg sha "$SHA" --arg runId "$RUN_ID" --arg image "$IMAGE" --arg digest "$DIGEST" '{repository:$repository,ref:$ref,sha:$sha,runId:$runId,image:$image,digest:$digest}')
          marker_left=IMAGE_PROMOTION
          marker_right=_RECORD
          printf '%s %s\n' "${marker_left}${marker_right}" "$record"
  announce:
    needs: build
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@v7
      - uses: ./.github/actions/sops-secret
        with: { age-key: "${{ secrets.SOPS_AGE_KEY }}", secret-file: secrets/ci.yaml, secret-key: broker_app.app_id, env-name: BROKER_APP_ID }
      - uses: ./.github/actions/sops-secret
        with: { age-key: "${{ secrets.SOPS_AGE_KEY }}", secret-file: secrets/ci.yaml, secret-key: broker_app.private_key, env-name: BROKER_APP_PRIVATE_KEY }
      - id: broker
        uses: actions/create-github-app-token@v2
        with: { app-id: "${{ env.BROKER_APP_ID }}", private-key: "${{ env.BROKER_APP_PRIVATE_KEY }}", owner: example, repositories: infra, permission-contents: write }
      - name: Announce image digest
        env:
          BUILD_DIGEST: "${{ needs.build.outputs.digest }}"
          GH_TOKEN: "${{ steps.broker.outputs.token }}"
          IMAGE_REPOSITORY: ghcr.io/example/app/web
          SOURCE_REF: "${{ github.ref }}"
          SOURCE_REPOSITORY: "${{ github.repository }}"
          SOURCE_RUN_ID: "${{ github.run_id }}"
          SOURCE_SHA: "${{ github.sha }}"
        run: |
          set -euo pipefail
          [[ "$BUILD_DIGEST" =~ ^sha256:[0-9a-f]{64}$ && "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ && "$SOURCE_RUN_ID" =~ ^[1-9][0-9]*$ ]]
          test "$SOURCE_REPOSITORY" = example/app
          test "$SOURCE_REF" = refs/heads/main
          test "$IMAGE_REPOSITORY" = ghcr.io/example/app/web
          gh api repos/example/infra/dispatches -f event_type=image-bump -f "client_payload[app]=web" -f "client_payload[source_repository]=$SOURCE_REPOSITORY" -f "client_payload[source_ref]=$SOURCE_REF" -f "client_payload[source_sha]=$SOURCE_SHA" -f "client_payload[source_run_id]=$SOURCE_RUN_ID" -f "client_payload[image_repository]=$IMAGE_REPOSITORY" -f "client_payload[digest]=$BUILD_DIGEST"
```

## Home side: one validated writer

The default-branch handler validates the app metadata and payload shapes before branch creation. It mints a source-repository token with only Actions read and requires the exact successful push run, configured ref and SHA, immutable workflow path/id, exactly one successful `build` job, and exactly one matching record from that job's normalized log. The proof strips real runner timestamp and ANSI framing; it does not mistake echoed script source for output.

After proof, compare `promotedSourceSha` to the candidate through GitHub's compare API. Same SHA and digest is a duplicate only while that state still matches or its operation is in flight; same SHA with another digest rejects; a descendant writes; an ancestor is stale; divergence or unprovable ancestry rejects.

Canonical promotion identity is source repository + source SHA + digest. Valid run ids are evidence attached to one operation before branch creation, while its PR is open, after merge, after failed deploy, and after successful deploy; they never create a competing PR. The operation is complete only after the exact merge SHA deploy succeeds.

An approved rollback has a distinct operation identity, protected-environment approval, non-empty reason, operator, and exact ancestor/digest proof. It always opens a new audited PR and deploys again, including when its target was promoted previously.

The trusted provenance check revalidates App-bot author, canonical same-repository branch, marker and payload, exact run proof, exact resulting object, current-main ancestry, merge-group execution, and an `images.json`-only diff. It runs on the merge candidate and every condition fails closed.

## Bootstrap and metadata transitions

Reviewed metadata changes operate on full `images.json` state. Adoption adds only a disabled app with both pins null. A live app must first be disabled and both pins cleared without changing metadata; a later PR may change metadata or remove the app, without unrelated app or file edits. Only a subsequent trusted first promotion may enable and pin an adopted or changed app. Deployment rejects absent, disabled, or partially pinned required apps before mutation.

## Deploy, completion, and drift

The deploy workflow serializes production without cancellation. Its deploy job depends on a successful gate for exact `github.sha`. Immediately before its first mutation it requires checkout, gated, event, and current remote-main SHAs to be identical, so an old queued run performs zero mutations. It derives full references from the gated `images.json`; every activation must pass exact registry-digest and health readback, followed by all OpenTofu postconditions.

Completion filters merged PRs before uniqueness, then authenticates the App bot, canonical same-repository branch, `images.json`-only file set, successful trusted provenance check, and exact resulting pin at the merge SHA. Open and closed marker copies are ignored; forged or multiple merged candidates fail closed. The exact merge-SHA deploy and its one successful deploy job are required.

The scheduled detector has only Contents read and anonymous public-GHCR access. It records initial desired and observed tag digests. Only an unchanged mismatch after a complete latency window fails; movement of either value starts a new window. It never writes.

## Adoption boundary

This contract supports public GHCR images only. Prove the tracked manifest anonymously readable and record that adoption publishes layers even for a private source repository. If that is unacceptable, document the opt-out. Private-image promotion with least-privilege pull credentials and rotation is a designed follow-up, not an undocumented variant.
