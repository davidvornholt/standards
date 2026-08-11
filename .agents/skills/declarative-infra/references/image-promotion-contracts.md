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
  - exactRegistryAccessProof
  - exactResultingObject
  - currentMainAncestry
  - mergeGroupRevalidation
  - imagesJsonOnly
rollback:
  identity: rollback:<current-identity>-><target-identity>
  required: [protectedApproval, nonEmptyReason, operator, exactAncestorDigestProof]
superseding:
  trigger: promotion-opened-or-reused
  candidates: same-app-open-promotions
  compareOutcome: descendant
  result: superseded
lifecycle: [announced, branch, open, merged, deploy-failed, completed, superseded]
```

<!-- contract:metadata-transition -->
```yaml
imagesPath: infra/images.json
metadataFields: [sourceRepository, sourceRef, sourceWorkflow, imageRepository, registryAccess, trackedTag, promotionLatencyMinutes]
pinFields: [promotionEnabled, digest, promotedSourceSha]
disabledPin: { promotionEnabled: false, digest: null, promotedSourceSha: null }
operations:
  bootstrap: absent-to-disabled
  accessMigration: legacy-document-to-explicit-access-only
  disable: live-to-disabled-with-metadata-unchanged
  metadata: disabled-to-disabled
  remove: disabled-to-absent
  trustedPromotion: disabled-to-enabled-with-exact-proof
```

<!-- contract:registry-access -->
```yaml
public:
  detectorCredential: none
  detectorProof: anonymously-readable
  hostCredential: none
  hostAuthFile: /run/containers/auth/anonymous.json
private:
  detectorCredential: github-actions-token
  detectorPermissions: { contents: read, packages: read }
  detectorProof: exact-private-visibility-then-anonymous-denied-then-authenticated-readable
  hostCredential: sops-classic-pat
  hostCredentialScopes: [read:packages]
  hostCredentialAuthority: all-packages-readable-by-token-owner
  hostIdentityPolicy: dedicated-package-reader-or-explicit-account-wide-acceptance
  hostAuthFile: /run/containers/auth/ghcr-private.json
  secretRestartUnits: [podman-ghcr-login.service]
  rotationChecks: [intended-package-readable, unrelated-package-authority-reviewed]
  rotation: replace-verify-revoke
forbiddenDesiredStateFields: [credential, secretPath, username, authFile]
```

<!-- contract:registry-resolution -->
```sh
set -euo pipefail
case "$REGISTRY_ACCESS" in
  public)
    resolve-anonymous-tag
    ;;
  private)
    require-exact-private-visibility
    reject-anonymous-readable
    resolve-authenticated-tag
    ;;
  *)
    printf 'unsupported registry access mode: %s\n' "$REGISTRY_ACCESS" >&2
    exit 1
    ;;
esac
```

<!-- contract:registry-access-proof -->
```sh
set -euo pipefail
image_repository=${1:?image repository is required}
digest=${2:?digest is required}
registry_access=${3:?registry access mode is required}
[[ "$image_repository" =~ ^ghcr\.io/[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$ ]]
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
case "$registry_access" in
  public)
    anonymous_digest=$(resolve-anonymous-digest "$image_repository")
    test "$anonymous_digest" = "$digest"
    ;;
  private)
    package=$(read-provider-package-metadata "$image_repository")
    jq -er --arg image "$image_repository" 'select(.imageRepository == $image and .visibility == "private") | true' <<<"$package" >/dev/null
    if resolve-anonymous-digest "$image_repository" >/dev/null 2>&1; then
      printf 'private image unexpectedly allows anonymous access: %s\n' "$image_repository" >&2
      exit 1
    fi
    authenticated_digest=$(resolve-job-token-digest "$image_repository")
    test "$authenticated_digest" = "$digest"
    ;;
  *)
    printf 'unsupported registry access mode: %s\n' "$registry_access" >&2
    exit 1
    ;;
esac
```

<!-- contract:host-registry-login -->
```sh
set -euo pipefail
install -d -m 0700 "$(dirname "$PRIVATE_AUTH_FILE")"
temporary_auth=$(mktemp "${PRIVATE_AUTH_FILE}.tmp.XXXXXX")
trap 'rm -f "$temporary_auth"' EXIT
printf '{"auths":{}}\n' >"$temporary_auth"
chmod 0600 "$temporary_auth"
podman login ghcr.io --authfile "$temporary_auth" --username "$REGISTRY_USERNAME" --password-stdin <"$REGISTRY_TOKEN_FILE"
mv -f "$temporary_auth" "$PRIVATE_AUTH_FILE"
trap - EXIT
```

<!-- contract:host-registry-pull -->
```sh
set -euo pipefail
case "$REGISTRY_ACCESS" in
  public) auth_file=$PUBLIC_AUTH_FILE ;;
  private) auth_file=$PRIVATE_AUTH_FILE ;;
  *) printf 'unsupported registry access mode: %s\n' "$REGISTRY_ACCESS" >&2; exit 1 ;;
esac
test -r "$auth_file"
REGISTRY_AUTH_FILE="$auth_file" podman pull --authfile "$auth_file" "$IMAGE_REFERENCE"
```

<!-- contract:private-host-migration -->
```yaml
authFiles:
  public: /run/containers/auth/anonymous.json
  private: /run/containers/auth/ghcr-private.json
stages:
  plumbing:
    allowedAppState: disabled-or-public
    privatePrePull: forbidden
    requiredReadback: [sops-secret, login-unit-success, private-auth-file]
  privatePromotion:
    requires: plumbing-readback
    allowedAppState: private
    privatePrePull: required
appliesTo: [new-private-adoption, public-to-private-migration]
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
      - name: Revalidate exact registry access
        run: verify-registry-access "$IMAGE_REPOSITORY" "$DIGEST" "$REGISTRY_ACCESS"
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
