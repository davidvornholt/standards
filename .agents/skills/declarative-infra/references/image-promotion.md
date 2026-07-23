# Image promotion (source repo to infra home)

When an app's infrastructure home is a dedicated infra repo, deployment freshness is automation-owned: the source repo announces every successful public-image build, and the home repo's trusted writer proposes the desired-state change. An agent merging an app change never edits the pin by hand and never treats "source PR merged" or "bump PR merged" as "deployed".

**Completion invariant:** a source change is done only when the exact infra merge SHA has passed its own fail-closed gate and every required target has returned a healthy readback of the expected digest. A failed or partial activation is explicitly incomplete; do not report done and do not hide it behind an automatic cross-system rollback.

## One desired-state owner

The home repo owns one `images.json` (`infra/images.json`, or root `images.json` in a dedicated infra repo). Every consumer — announcement validation, the trusted writer, deployment, readback, and drift detection — reads this per-app object:

<!-- contract:images-json -->
```json
{
  "web": {
    "sourceRepository": "example/app",
    "sourceRef": "refs/heads/main",
    "imageRepository": "ghcr.io/example/app/web",
    "trackedTag": "main",
    "promotionLatencyMinutes": 30,
    "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "promotedSourceSha": "1111111111111111111111111111111111111111"
  }
}
```

The production reference is derived as `imageRepository@digest`; no other production digest source is allowed. `images.json` is declarative deployment desired state, not a credential manifest: unlike the rejected third credential ledger in `CREDS-CLOUDFLARE-001`, this file is the single state owner that automation converges.

## Source side: announce the built digest

The build job publishes `imageRepository:trackedTag` and exposes the registry-returned digest. A separate announcement job runs only after that job succeeds. Its fallback `GITHUB_TOKEN` is read-only; its one-repository App token has only Contents write, the permission required by `repository_dispatch`.

The App credentials live at `ci.broker_app.app_id` and `ci.broker_app.private_key` in `secrets/ci.yaml`. Resolve both with the canonical action: it transports the nested multiline private key through `GITHUB_ENV`, never an output.

<!-- contract:source-workflow -->
```yaml
permissions:
  contents: read
jobs:
  build:
    permissions:
      contents: read
      packages: write
    outputs:
      digest: ${{ steps.build.outputs.digest }}
    steps:
      - id: build
        uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/example/app/web:main
  announce:
    needs: build
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
      - name: Resolve broker App id
        uses: ./.github/actions/sops-secret
        with:
          age-key: ${{ secrets.SOPS_AGE_KEY }}
          secret-file: secrets/ci.yaml
          secret-key: broker_app.app_id
          env-name: BROKER_APP_ID
      - name: Resolve broker App private key
        uses: ./.github/actions/sops-secret
        with:
          age-key: ${{ secrets.SOPS_AGE_KEY }}
          secret-file: secrets/ci.yaml
          secret-key: broker_app.private_key
          env-name: BROKER_APP_PRIVATE_KEY
      - id: broker
        uses: actions/create-github-app-token@v2
        with:
          app-id: ${{ env.BROKER_APP_ID }}
          private-key: ${{ env.BROKER_APP_PRIVATE_KEY }}
          owner: example
          repositories: infra
          permission-contents: write
      - name: Announce image digest
        env:
          BUILD_DIGEST: ${{ needs.build.outputs.digest }}
          GH_TOKEN: ${{ steps.broker.outputs.token }}
          IMAGE_REPOSITORY: ghcr.io/example/app/web
          SOURCE_REF: ${{ github.ref }}
          SOURCE_REPOSITORY: ${{ github.repository }}
          SOURCE_RUN_ID: ${{ github.run_id }}
          SOURCE_SHA: ${{ github.sha }}
        run: |
          set -euo pipefail
          [[ "$BUILD_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]
          [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]
          [[ "$SOURCE_RUN_ID" =~ ^[1-9][0-9]*$ ]]
          test "$SOURCE_REPOSITORY" = example/app
          test "$SOURCE_REF" = refs/heads/main
          test "$IMAGE_REPOSITORY" = ghcr.io/example/app/web
          gh api repos/example/infra/dispatches \
            -f event_type=image-bump \
            -f "client_payload[app]=web" \
            -f "client_payload[source_repository]=$SOURCE_REPOSITORY" \
            -f "client_payload[source_ref]=$SOURCE_REF" \
            -f "client_payload[source_sha]=$SOURCE_SHA" \
            -f "client_payload[source_run_id]=$SOURCE_RUN_ID" \
            -f "client_payload[image_repository]=$IMAGE_REPOSITORY" \
            -f "client_payload[digest]=$BUILD_DIGEST"
```

## Home side: one validated writer

The default-branch dispatch handler validates everything before creating a branch: the app exists; source repository/ref and image repository exactly equal its `images.json` fields; digest is anchored lowercase `sha256:` plus 64 hex characters; source SHA is 40 hex characters; and run id is a positive integer. It queries that run in the configured source repository and requires a `push` on the configured ref, the exact head SHA, and a successful build job.

It then compares the committed `promotedSourceSha` to the candidate with GitHub's compare API. The required transition table is:

<!-- contract:transition-table -->
| Relationship and payload | Result |
| --- | --- |
| same SHA, same digest | `duplicate-noop` |
| same SHA, different digest | `reject` |
| candidate descends from current | `write` |
| candidate is an ancestor of current | `stale-noop` |
| candidate diverged or ancestry is unprovable | `reject` |
| audited rollback to an ancestor | `write-rollback` |

Every accepted write uses branch `image-bump/<app>/<source-run-id>`, changes only that app's `digest` and `promotedSourceSha`, and puts the exact validated payload plus marker `promotion-source: <repo>@<sha>#<run-id>` in the PR body. Before merge, a required provenance check running trusted default-branch code revalidates the App bot author, same-repository branch, marker/payload/run identity, exact resulting object, current-main ancestry, and an `images.json`-only diff. Human, fork, wrong-bot, unrelated-file, tampered, duplicate, and reordered PRs fail closed or take the defined no-op; the check must run again for the merge-group/merge candidate so concurrent PR order cannot roll state back.

The home-side writer's App installation token is restricted to `permission-contents: write` and `permission-pull-requests: write`; omit every broader permission. An audited rollback is a `workflow_dispatch` into this same writer, requires a protected-environment approval and non-empty reason, verifies the target is an ancestor with an exact digest binding, records operator/reason in the PR, and uses the same provenance gate. There is no direct human edit escape hatch.

## Deploy the exact merged state

The main deploy workflow uses `concurrency` with `cancel-in-progress: false`. Its gate checks out and validates `github.sha`, exposes that SHA, and the mutation job depends on that successful result. Immediately before its first external mutation, the serialized job requires its checkout, gated SHA, event SHA, and current remote `refs/heads/main` to be identical; an older queued run exits incomplete without mutation.

<!-- contract:deploy-guard -->
```yaml
concurrency:
  group: production
  cancel-in-progress: false
jobs:
  gate:
    outputs:
      gated-sha: ${{ steps.gated.outputs.sha }}
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.sha }}
      - run: bun run check
      - id: gated
        run: echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
  deploy:
    needs: gate
    if: ${{ needs.gate.result == 'success' && needs.gate.outputs.gated-sha == github.sha }}
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.sha }}
      - name: Verify exact current main
        env:
          GATED_SHA: ${{ needs.gate.outputs.gated-sha }}
        run: |
          set -euo pipefail
          test "$(git rev-parse HEAD)" = "$GATED_SHA"
          test "$GATED_SHA" = "$GITHUB_SHA"
          test "$(git ls-remote origin refs/heads/main | cut -f1)" = "$GATED_SHA"
      - name: Mutate and read back
        run: deploy-and-read-back
```

Derive each full image reference from the gated checkout's `images.json`, validate it again, and export the declared build environment variable before building the host (for example, `WEB_IMAGE=ghcr.io/example/app/web@sha256:...`; see `bootstrap.md`). After every host activation, query that target's running container image id, resolve that image id's registry digest, require it to equal the app's desired digest, and require the app health check to pass. Verify every required host and any OpenTofu postconditions. If a later mutation or readback fails, report which targets changed and which passed; the run stays red/incomplete even though some targets may already serve the new image.

## Trace completion

Trace by the unique source identity, never by a generic PR title:

```sh
marker="promotion-source: example/app@${SOURCE_SHA}#${SOURCE_RUN_ID}"
pr=$(gh pr list --repo example/infra --state all --search "\"$marker\" in:body" --json number,body --jq 'map(select(.body | contains($m))) | if length == 1 then .[0].number else error("expected one promotion PR") end' --arg m "$marker")
merge_sha=$(gh pr view "$pr" --repo example/infra --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')
run_id=$(gh run list --repo example/infra --workflow deploy.yml --commit "$merge_sha" --json databaseId,headSha --jq 'map(select(.headSha == $sha)) | if length == 1 then .[0].databaseId else error("expected one exact-SHA deploy") end' --arg sha "$merge_sha")
gh run watch "$run_id" --repo example/infra --exit-status
gh run view "$run_id" --repo example/infra --json headSha,conclusion,jobs --jq 'select(.headSha == $sha and .conclusion == "success") | .jobs[] | select(.name == "deploy" and .conclusion == "success")' --arg sha "$merge_sha"
```

The successful `deploy` job includes the per-target digest and health readback. Concurrent promotions have different markers, so these queries cannot silently match another source run.

## Read-only drift detection

A scheduled detector has only `contents: read` and anonymous read access to the public GHCR image. For each app it resolves `imageRepository:trackedTag`; equal digest is healthy. On mismatch it waits that app's `promotionLatencyMinutes`, then resolves the tag and current main `images.json` again. It fails loudly only when the same checkout is still current and the tag still differs after that complete observation window; if desired state changed, it restarts comparison from the new state. A restarted job begins a fresh observation window. It never commits, dispatches, opens/updates a PR, invokes the writer, or mutates the registry.

<!-- contract:home-policy -->
```yaml
writer-token-permissions: { contents: write, pull-requests: write }
drift-token-permissions: { contents: read }
drift-registry-auth: anonymous-public
drift-on-mismatch: wait-and-recheck
drift-writes: []
```

## Adoption boundary

This contract supports public GHCR images only. Before enabling promotion, set the package visibility to public and prove its tracked manifest is anonymously readable. Adopting it publishes image contents and layers even when the source repository is private. Record that disclosure and acceptance in the host repo; if public layers are unacceptable, defer adoption and document the opt-out. Private-image promotion — least-privilege workflow and host pull credentials, rotation, and readback — is a designed follow-up, not an undocumented variant of this pattern.
