# Image promotion (source repo to infra home)

When an app's infrastructure home is a dedicated infra repo, deployment freshness is automation-owned: the source repo announces every successful image build, and the home repo's trusted writer proposes the desired-state change. Never edit a live pin by hand or treat either PR merge as deployment completion.

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
    "registryAccess": "private",
    "trackedTag": "main",
    "promotionLatencyMinutes": 30,
    "promotionEnabled": true,
    "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "promotedSourceSha": "1111111111111111111111111111111111111111"
  }
}
```

`sourceWorkflow.path` and `sourceWorkflow.id` bind the immutable authorized Actions workflow; a different successful workflow with a job named `build` is not evidence. `registryAccess` is required metadata with exactly two values: `public` requires anonymous manifest access, while `private` requires exact provider visibility `private`, anonymous denial, and authenticated workflow and host access. Every reader first requires a plain object document root, then validates each complete object at runtime: the exact metadata and pin key sets, a GHCR repository, the access enum, and valid paired pins. Arrays, primitives, prototype-bearing objects, unknown fields, and authentication material fail closed. Derive production references only as `imageRepository@digest`. `images.json` is the single declarative state owner being converged, not a third credential ledger of the kind rejected by `CREDS-CLOUDFLARE-001`; it never contains a credential, secret path, username, or authentication-file path.

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

Opening or reusing a promotion PR retires every other trusted open promotion for the same app when the new candidate is provably a descendant of the other candidate. The writer uses the same source-repository compare proof as the provenance gate and fails closed: an ancestor, equal, diverged, or unprovable candidate closes nothing. A retired operation enters the terminal `superseded` phase and cannot merge or deploy; later announcements of its canonical identity attach as evidence instead of opening another PR or advancing the operation.

Supersession deliberately gives up the older candidate as an immediate availability fallback. If B supersedes A and then fails to merge or deploy, operators repair or retry B or announce a newer source build; they never reopen A or move A out of `superseded`, even if A's branch and PR still exist. Restoring a previously deployed A digest requires the distinct approved rollback operation below, so it does not reactivate A's promotion identity.

An approved rollback has a distinct operation identity, protected-environment approval, non-empty reason, operator, and exact ancestor/digest proof. It always opens a new audited PR and deploys again, including when its target was promoted previously.

Before branch creation, the writer runs the shared registry-access proof against the exact `imageRepository@digest`. Public proof resolves that digest anonymously. Private proof queries the exact GHCR package path and requires provider visibility `private`, denies anonymous resolution, and resolves the same digest with the job token. Missing package grants, inaccessible provider visibility, `internal` visibility, and any path or digest mismatch fail before a branch exists.

The trusted provenance check revalidates App-bot author, canonical same-repository branch, marker and payload, exact run proof, exact registry-access proof, exact resulting object, current-main ancestry, merge-group execution, and an `images.json`-only diff. It runs on the merge candidate and every condition fails closed.

## Bootstrap and metadata transitions

Reviewed metadata changes operate on full `images.json` state. Adoption adds only a disabled app with both pins null. A live app must first be disabled and both pins cleared without changing metadata; a later PR may change metadata or remove the app, without unrelated app or file edits. Only a subsequent trusted first promotion may enable and pin an adopted or changed app. Deployment rejects absent, disabled, or partially pinned required apps before mutation.

The `registryAccess` hard cutover has one document-wide migration operation for an existing legacy `images.json`. Its before-state decoder accepts exact legacy entries only for this operation. In one atomic change, every legacy entry gains `registryAccess: public|private`, already-final entries remain semantically unchanged, and no pin, existing metadata value, app membership, or other file may change; object-key order is irrelevant. The complete after document must pass the strict final decoder, and every other operation rejects the legacy shape. This is a one-time durable-config migration, not an optional field or compatibility alias.

Private host adoption has a separate two-stage boundary that runs before private metadata or promotion can require a pull. First deploy the SOPS secret, login unit, explicit auth files, and container-unit environment while a new app remains disabled or the existing app remains public. Read back the decrypted secret presence, successful login unit, and root-only private auth file. Only a later reviewed metadata change and trusted promotion may select `private` and require private pre-pull. The same sequence applies to a new private app and a public-to-private migration; an old host never has to pull a private image to install the credential plumbing needed for that pull.

## Deploy, completion, and drift

The deploy workflow serializes production without cancellation. Its deploy job depends on a successful gate for exact `github.sha`. Immediately before its first mutation it requires checkout, gated, event, and current remote-main SHAs to be identical, then reruns the shared exact repository/digest registry-access proof from the gated `images.json`. A queued run therefore performs zero mutations when main moved, visibility changed, anonymous access changed, or the job token lost its package grant. It derives full references from the gated `images.json`; every activation must pass exact registry-digest and health readback, followed by all OpenTofu postconditions.

Completion filters merged PRs before uniqueness, then authenticates the App bot, canonical same-repository branch, `images.json`-only file set, successful trusted provenance check, and exact resulting pin at the merge SHA. Open and closed marker copies are ignored; forged or multiple merged candidates fail closed. The exact merge-SHA deploy and its one successful deploy job are required.

The scheduled detector has Contents read and Packages read through its per-job `GITHUB_TOKEN`. It records initial desired and observed tag digests. A public entry resolves anonymously and fails when anonymous access stops working. A private entry queries the GitHub package API for the exact package path and fails unless visibility is exactly `private`; inability to read visibility also fails. It then proves anonymous denial and resolves the same digest with the workflow token; grant the infrastructure repository read access in that package's Actions access settings. `internal` is not private: broader organization or enterprise access fails the declared mode even though anonymous access is denied. Missing package access, a package that became public, an invalid access mode, or any registry error fails closed. Only an unchanged mismatch after a complete latency window fails; movement of either value starts a new window. The detector never writes and never decrypts a durable registry credential.

## Private GHCR host access

GitHub-hosted workflows authenticate private GHCR reads with their job-scoped `GITHUB_TOKEN`; a standalone host cannot. A host with any `private` entry keeps one classic GitHub PAT with the sole scope `read:packages` in its SOPS-encrypted host target at `registry.github_token`. The corresponding GitHub username is non-secret configuration. This is scope-minimal, not package-resource-minimal: the PAT can read every private package its owning account may read, and future account grants widen the host's authority. The infrastructure repo must either name a dedicated package-reader identity whose grants are limited to the host's declared packages or record an explicit acceptance of the account-wide readable-package blast radius. Do not store the PAT in `images.json`, a Nix expression, the Nix store, a workflow secret, or a GitHub App private key on the host.

A `podman-ghcr-login` oneshot reads the SOPS path through stdin and atomically replaces `/run/containers/auth/ghcr-private.json`: it logs in to a same-directory `0600` temporary file, renames it only after success, and never passes the PAT as an argument. The SOPS declaration for `registry.github_token` includes `restartUnits = [ "podman-ghcr-login.service" ]`, so activating a replacement refreshes Podman's copied state. Every private-image migration and container unit orders after and requires that login unit. Its pre-pull and unit environment set `REGISTRY_AUTH_FILE` to the private path, and every explicit Podman registry command also passes `--authfile` with that path.

Activation also creates `/run/containers/auth/anonymous.json` as a root-owned `0600` file containing exactly `{"auths":{}}`. Every public pre-pull, migration, and container unit sets `REGISTRY_AUTH_FILE` to that file, and explicit pulls also pass `--authfile` with it. An explicit auth file prevents fallback to Podman's ambient auth and `~/.docker/config.json`; valid, invalid, or stale private credentials therefore cannot affect a public cached or uncached pull. Public units have no login dependency, while private units never receive the anonymous file.

Rotation is replace, refresh, verify, revoke: create a replacement classic PAT with only `read:packages`; re-check which intended and unrelated packages its owner can read; atomically replace `registry.github_token` in the SOPS host target; deploy and read back the restarted login unit and exact private auth file; then force an uncached authenticated digest lookup or pull with `REGISTRY_AUTH_FILE` and `--authfile` both naming that file. Revoke the old PAT only after the replacement succeeds from that exact state. GitHub provides no broker API for classic package PAT creation or rotation, so this credential is a documented manual exception to `bun standards creds`; `creds plan` and `creds apply` never claim to manage it.

## Adoption boundary

This contract supports public and private GHCR images. Choose `registryAccess` explicitly during disabled adoption and prove that access mode before the first trusted promotion. Source-repository API access remains a separate plane: a private source repository uses the existing broker App's short-lived Actions-read token for provenance and drift timing, never the registry PAT. Registries other than GHCR and private-image credentials other than the host `read:packages` PAT are out of scope and require a new reviewed contract.
