# Image promotion contracts

These copyable fragments are mechanically exercised by the standards CLI test suite and complete [Image promotion](image-promotion.md).

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
jq -er --arg ref "$SOURCE_REF" --arg sha "$SOURCE_SHA" --arg workflow "$SOURCE_WORKFLOW_PATH" --arg workflowId "$SOURCE_WORKFLOW_ID" 'select(.event == "push" and .head_branch == ($ref | sub("^refs/heads/"; "")) and .head_sha == $sha and .conclusion == "success" and .path == $workflow and .workflow_id == ($workflowId | tonumber)) | true' <<<"$run" >/dev/null
jobs=$(gh api "repos/$SOURCE_REPOSITORY/actions/runs/$SOURCE_RUN_ID/jobs" --paginate --slurp)
job_id=$(jq -er '[.[].jobs[] | select(.name == "build" and .conclusion == "success")] | if length == 1 then .[0].id else error("expected one successful build job") end' <<<"$jobs")
gh api "repos/$SOURCE_REPOSITORY/actions/jobs/$job_id/logs" >"$RUNNER_TEMP/build.log"
escape=$'\033'
normalized=$(sed -E "s/${escape}\\[[0-9;]*[[:alpha:]]//g; s/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[^[:space:]]+[[:space:]]//" "$RUNNER_TEMP/build.log")
marker_left=IMAGE_PROMOTION
marker_right=_RECORD
records=$(sed -n "s/^${marker_left}${marker_right} //p" <<<"$normalized" | jq -cs '.')
jq -er --arg repository "$SOURCE_REPOSITORY" --arg ref "$SOURCE_REF" --arg sha "$SOURCE_SHA" --arg runId "$SOURCE_RUN_ID" --arg image "$IMAGE_REPOSITORY" --arg digest "$DIGEST" 'if length == 1 and .[0] == {repository:$repository,ref:$ref,sha:$sha,runId:$runId,image:$image,digest:$digest} then true else error("build log does not bind this promotion") end' <<<"$records" >/dev/null
```

<!-- contract:writer-provenance -->
```yaml
identityFields: [sourceRepository, sourceSha, digest]
runEvidenceField: sourceRunId
compareOutcomes:
  same: duplicate-if-current-or-in-flight
  descendant: write
  ancestor: stale
  diverged: reject
  unprovable: reject
canonical:
  branch: image-bump/<app>/<sha-prefix>-<digest-prefix>
  marker: "promotion-source: <repository>@<sha> digest=<digest>"
requiredProvenance:
  - appBotAuthor
  - canonicalSameRepositoryBranch
  - canonicalMarker
  - exactPayload
  - exactRunProof
  - exactResultingObject
  - currentMainAncestry
  - mergeGroupRevalidation
  - imagesJsonOnly
rollback:
  identity: rollback:<current-identity>-><target-identity>
  required: [protectedApproval, nonEmptyReason, operator, exactAncestorDigestProof]
lifecycle: [announced, branch, open, merged, deploy-failed, completed]
```

<!-- contract:metadata-transition -->
```yaml
imagesPath: infra/images.json
metadataFields: [sourceRepository, sourceRef, sourceWorkflow, imageRepository, trackedTag, promotionLatencyMinutes]
pinFields: [promotionEnabled, digest, promotedSourceSha]
disabledPin: { promotionEnabled: false, digest: null, promotedSourceSha: null }
operations:
  bootstrap: absent-to-disabled
  disable: live-to-disabled-with-metadata-unchanged
  metadata: disabled-to-disabled
  remove: disabled-to-absent
  trustedPromotion: disabled-to-enabled-with-exact-proof
```

<!-- contract:deploy-guard -->
```yaml
concurrency: { group: production, cancel-in-progress: false }
jobs:
  gate:
    outputs: { gated-sha: "${{ steps.gated.outputs.sha }}" }
    steps:
      - uses: actions/checkout@v7
        with: { ref: "${{ github.sha }}" }
      - run: bun run check
      - id: gated
        run: echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
  deploy:
    needs: gate
    if: "${{ needs.gate.result == 'success' && needs.gate.outputs.gated-sha == github.sha }}"
    steps:
      - uses: actions/checkout@v7
        with: { ref: "${{ github.sha }}" }
      - name: Verify exact current main
        env: { GATED_SHA: "${{ needs.gate.outputs.gated-sha }}" }
        run: |
          set -euo pipefail
          checkout_sha=$(git rev-parse HEAD)
          remote_main_sha=$(git ls-remote origin refs/heads/main | cut -f1)
          test "$checkout_sha" = "$GATED_SHA"
          test "$GATED_SHA" = "$GITHUB_SHA"
          test "$GITHUB_SHA" = "$remote_main_sha"
      - name: Mutate and read back
        run: deploy-and-read-back
```

<!-- contract:completion-trace -->
```sh
set -euo pipefail
marker="promotion-source: ${SOURCE_REPOSITORY}@${SOURCE_SHA} digest=${DIGEST}"
digest_hex=${DIGEST#sha256:}
branch="image-bump/${APP}/${SOURCE_SHA:0:12}-${digest_hex:0:12}"
prs=$(gh pr list --repo example/infra --state all --search "\"$marker\" in:body" --json number,body,state)
pr=$(jq -er --arg marker "$marker" '[.[] | select(.state == "MERGED" and (.body | contains($marker)))] | if length == 1 then .[0].number else error("expected one merged promotion PR") end' <<<"$prs")
view=$(gh pr view "$pr" --repo example/infra --json state,mergeCommit,author,headRefName,headRepository,files,statusCheckRollup)
merge_sha=$(jq -er --arg branch "$branch" 'if .state == "MERGED" and .author.login == "promotion-bot[bot]" and .headRefName == $branch and .headRepository.nameWithOwner == "example/infra" and [.files[].path] == ["infra/images.json"] and ([.statusCheckRollup[] | select(.name == "trusted-promotion-provenance" and .conclusion == "SUCCESS")] | length) == 1 then .mergeCommit.oid else error("merged promotion PR is not trusted") end' <<<"$view")
encoded=$(gh api "repos/example/infra/contents/infra/images.json?ref=$merge_sha")
images=$(jq -er '.content' <<<"$encoded" | base64 --decode)
jq -er --arg app "$APP" --arg digest "$DIGEST" --arg sha "$SOURCE_SHA" 'select(.[$app].promotionEnabled == true and .[$app].digest == $digest and .[$app].promotedSourceSha == $sha) | true' <<<"$images" >/dev/null
runs=$(gh run list --repo example/infra --workflow deploy.yml --commit "$merge_sha" --json databaseId,headSha)
run_id=$(jq -er --arg sha "$merge_sha" '[.[] | select(.headSha == $sha)] | if length == 1 then .[0].databaseId else error("expected one exact-SHA deploy") end' <<<"$runs")
gh run watch "$run_id" --repo example/infra --exit-status
result=$(gh run view "$run_id" --repo example/infra --json headSha,conclusion,jobs)
jq -er --arg sha "$merge_sha" 'if .headSha == $sha and .conclusion == "success" and ([.jobs[] | select(.name == "deploy" and .conclusion == "success")] | length) == 1 and ([.jobs[] | select(.name == "deploy")] | length) == 1 then true else error("exact deploy did not complete successfully") end' <<<"$result" >/dev/null
```

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
