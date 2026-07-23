# Image promotion (source repo to infra home)

When an app's infrastructure home is a dedicated infra repo, deployment freshness is automation-owned: the source repo announces every successful public-image build, and the home repo's trusted writer proposes the desired-state change. Never edit a live pin by hand or treat either PR merge as deployment completion.

**Completion invariant:** a source change is done only when the exact infra merge SHA has passed its fail-closed gate and every required target has returned a healthy readback of the expected digest. A failed or partial activation is incomplete; report it instead of attempting automatic cross-system rollback.

## One desired-state owner

The home repo owns one `images.json` (`infra/images.json`, or root `images.json` in a dedicated infra repo). Announcement validation, the trusted writer, deployment, readback, and drift detection all read its per-app objects:

<!-- contract:images-json -->
```json
{
  "web": {
    "sourceRepository": "example/app",
    "sourceRef": "refs/heads/main",
    "imageRepository": "ghcr.io/example/app/web",
    "trackedTag": "main",
    "promotionLatencyMinutes": 30,
    "promotionEnabled": true,
    "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "promotedSourceSha": "1111111111111111111111111111111111111111"
  }
}
```

Derive production references only as `imageRepository@digest`. `images.json` is the single declarative state owner being converged, not a third credential ledger of the kind rejected by `CREDS-CLOUDFLARE-001`.

## Source side: bind and announce the build

The trusted build job publishes `imageRepository:trackedTag`, obtains the registry digest, and emits exactly one single-line JSON record to its immutable job log. A separate announcement job runs only after build success. Its fallback token is read-only; its one-infra-repository App token has only Contents write.

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
          jq -cn --arg repository "$REPOSITORY" --arg ref "$REF" --arg sha "$SHA" --arg runId "$RUN_ID" --arg image "$IMAGE" --arg digest "$DIGEST" \
            '{repository:$repository,ref:$ref,sha:$sha,runId:$runId,image:$image,digest:$digest}' |
            sed 's/^/IMAGE_PROMOTION_RECORD /'
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

The default-branch handler validates the app metadata and payload shapes. It mints a separate source-repository installation token with only `permission-actions: read`, requires the exact run to be a successful `push` on the configured ref and SHA, selects exactly one successful `build` job, fetches that exact job's log, and runs this proof before branch creation:

<!-- contract:source-token -->
```yaml
uses: actions/create-github-app-token@v2
with:
  owner: example
  repositories: app
  permission-actions: read
```

<!-- contract:source-proof -->
```sh
set -euo pipefail
run=$(gh api "repos/$SOURCE_REPOSITORY/actions/runs/$SOURCE_RUN_ID")
jq -er --arg ref "$SOURCE_REF" --arg sha "$SOURCE_SHA" 'select(.event == "push" and .head_branch == ($ref | sub("^refs/heads/"; "")) and .head_sha == $sha and .conclusion == "success") | true' <<<"$run" >/dev/null
jobs=$(gh api "repos/$SOURCE_REPOSITORY/actions/runs/$SOURCE_RUN_ID/jobs" --paginate --slurp)
job_id=$(jq -er '[.[].jobs[] | select(.name == "build" and .conclusion == "success")] | if length == 1 then .[0].id else error("expected one successful build job") end' <<<"$jobs")
gh api "repos/$SOURCE_REPOSITORY/actions/jobs/$job_id/logs" >"$RUNNER_TEMP/build.log"
records=$(sed -n 's/^.*IMAGE_PROMOTION_RECORD //p' "$RUNNER_TEMP/build.log" | jq -cs '.')
jq -er --arg repository "$SOURCE_REPOSITORY" --arg ref "$SOURCE_REF" --arg sha "$SOURCE_SHA" --arg runId "$SOURCE_RUN_ID" --arg image "$IMAGE_REPOSITORY" --arg digest "$DIGEST" 'if length == 1 and .[0] == {repository:$repository,ref:$ref,sha:$sha,runId:$runId,image:$image,digest:$digest} then true else error("build log does not bind this promotion") end' <<<"$records" >/dev/null
```

The home workflow creates that source token with `repositories: app` and `permission-actions: read`; its writer token separately has only `permission-contents: write` and `permission-pull-requests: write`. A different historical digest from the same repository therefore fails even when the run otherwise exists.

After proof, compare `promotedSourceSha` to the candidate through GitHub's compare API. Same SHA and digest is a duplicate; same SHA with another digest rejects; a descendant writes; an ancestor is stale; divergence or unprovable ancestry rejects. An approved rollback uses the same writer and proof, a protected environment, a non-empty reason, an exact ancestor/digest binding, and records operator/reason.

Canonical promotion identity is source repository + source SHA + digest; run id remains validated evidence, not identity. The canonical marker is `promotion-source: <repo>@<sha> digest=<digest>` and the branch is `image-bump/<app>/<sha-prefix>-<digest-prefix>`. Redelivery or another valid run for that identity resolves the existing PR/deploy and records the observed run id in the handler audit log; it never opens a competitor.

Every write changes only that app's pin fields. A required trusted provenance check revalidates App bot author, same-repository branch, canonical marker and payload, run proof, exact resulting object, current-main ancestry, and an `images.json`-only diff, including on merge groups.

## Bootstrap and metadata transitions

A reviewed metadata PR may add an app only as `promotionEnabled: false`, `digest: null`, and `promotedSourceSha: null`. Changing source repository/ref, image repository, tracked tag, or latency likewise atomically disables and clears any live pin; a live app cannot be removed until a reviewed PR first disables and clears it. Removal also updates the normal declarative required-app set. Deployment fails before mutation when a required app is absent, disabled, or has either pin field unset. Only the trusted writer, after full source proof, may atomically establish or re-establish `promotionEnabled: true` with a live digest and source SHA. Thus adoption, metadata change, and removal cannot silently reuse a digest under different metadata.

## Deploy the exact merged state

The main deploy workflow serializes with `concurrency: { group: production, cancel-in-progress: false }`. Its gate validates `github.sha`; the deploy job requires that successful exact-SHA output. Immediately before the first mutation it requires checkout SHA, gated SHA, event SHA, and current remote main SHA to match, then derives validated full references from `images.json`. After each activation it requires the running image's registry digest and health readback, then all OpenTofu postconditions. Partial success stays red and reports each changed/verified target.

## Trace completion

Trace the canonical identity, requiring exactly one merged PR, exact-SHA deploy run, and successful deploy job at every hop:

<!-- contract:completion-trace -->
```sh
set -euo pipefail
marker="promotion-source: ${SOURCE_REPOSITORY}@${SOURCE_SHA} digest=${DIGEST}"
prs=$(gh pr list --repo example/infra --state all --search "\"$marker\" in:body" --json number,body,state)
pr=$(jq -er --arg marker "$marker" '[.[] | select(.body | contains($marker))] | if length == 1 and .[0].state == "MERGED" then .[0].number else error("expected one merged promotion PR") end' <<<"$prs")
merge=$(gh pr view "$pr" --repo example/infra --json state,mergeCommit)
merge_sha=$(jq -er 'if .state == "MERGED" and (.mergeCommit.oid | type == "string") then .mergeCommit.oid else error("promotion PR is not merged") end' <<<"$merge")
runs=$(gh run list --repo example/infra --workflow deploy.yml --commit "$merge_sha" --json databaseId,headSha)
run_id=$(jq -er --arg sha "$merge_sha" '[.[] | select(.headSha == $sha)] | if length == 1 then .[0].databaseId else error("expected one exact-SHA deploy") end' <<<"$runs")
gh run watch "$run_id" --repo example/infra --exit-status
result=$(gh run view "$run_id" --repo example/infra --json headSha,conclusion,jobs)
jq -er --arg sha "$merge_sha" 'if .headSha == $sha and .conclusion == "success" and ([.jobs[] | select(.name == "deploy")] | length) == 1 and ([.jobs[] | select(.name == "deploy" and .conclusion == "success")] | length) == 1 then true else error("exact deploy did not complete successfully") end' <<<"$result" >/dev/null
```

The successful deploy job logs per-target digest and health readback. The same canonical trace works for the original or any duplicate valid run id.

## Read-only drift detection

The scheduled detector has only Contents read and anonymous access to public GHCR. It records both initial desired and observed tag digests. Only an unchanged mismatch after a complete latency window fails; movement of either value starts a new full window:

<!-- contract:drift-detector -->
```sh
set -euo pipefail
window=0
while :; do
  initial_desired=$(read-desired-digest "$window" initial)
  initial_observed=$(resolve-tracked-tag "$window" initial)
  test "$initial_desired" != "$initial_observed" || exit 0
  wait-promotion-window "$window"
  current_desired=$(read-desired-digest "$window" current)
  current_observed=$(resolve-tracked-tag "$window" current)
  if test "$current_desired" != "$initial_desired" || test "$current_observed" != "$initial_observed"; then window=$((window + 1)); continue; fi
  exit 1
done
```

The detector never commits, dispatches, opens/updates a PR, invokes the writer, or mutates the registry.

## Adoption boundary

This contract supports public GHCR images only. Prove the tracked manifest anonymously readable and record that adoption publishes layers even for a private source repository. If that is unacceptable, document the opt-out. Private-image promotion with least-privilege pull credentials and rotation is a designed follow-up, not an undocumented variant.
