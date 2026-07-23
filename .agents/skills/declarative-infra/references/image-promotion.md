# Image promotion (source repo to infra home)

When an app's infrastructure home is a dedicated infra repo, deployment freshness is automation-owned: the source repo announces every new image, and the home repo's own trusted automation converges. An agent merging an app change never edits the infra repo's pin by hand and never treats "source PR merged" as "deployed".

**Invariant: a source-repo change is deployed only when the home repo's digest pin has merged and its deploy workflow converged.** A source-repo agent finishing deployable work verifies the promotion landed (watch the dispatched run / bump PR in the home repo with `gh`) before reporting the change as done.

## Committed digest pins

The home repo commits its pins in a single `images.json` at the infra root (`infra/images.json`, or `images.json` in a dedicated infra repo), mapping app name to a full digest-pinned reference:

```json
{
  "web": "ghcr.io/<owner>/<repo>/web@sha256:..."
}
```

The deploy workflow reads this file and exports the values as the environment variables that enter the flake via `specialArgs` (see `bootstrap.md`); nothing else defines a production digest. This file is the reconciliation point: bumping it is the deploy, and its git history is the deploy history.

## Source side: announce the digest

The source repo's main-branch workflow, after building and pushing the image, fires a `repository_dispatch` at the home repo. The credential is a broker GitHub App installation token minted at runtime — put the App credentials in `secrets/ci.yaml` once with `bun standards creds add github --dest ci:ci.broker_app`:

```yaml
- name: Mint home-repo token
  id: broker
  uses: actions/create-github-app-token@v2
  with:
    app-id: ${{ steps.secrets.outputs.broker_app_id }}
    private-key: ${{ steps.secrets.outputs.broker_app_private_key }}
    owner: <owner>
    repositories: <infra-repo>
- name: Announce image digest
  env:
    GH_TOKEN: ${{ steps.broker.outputs.token }}
  run: |
    gh api repos/<owner>/<infra-repo>/dispatches \
      -f event_type=image-bump \
      -f 'client_payload[app]=web' \
      -f "client_payload[image]=ghcr.io/<owner>/<repo>/web@${DIGEST}"
```

## Home side: bump through the gates

The home repo handles the dispatch by updating `images.json` on a branch, opening a PR with a Conventional Commit title (`chore(web): bump image digest`), and enabling auto-merge. The infra gates (flake check, toplevel build, tofu plan) decide whether it lands; merge to main triggers the normal deploy workflow. The bump workflow validates the payload (known app key, `ghcr.io/...@sha256:` shape) and never edits anything but `images.json`.

Direct pushes to main are not an option here even for trusted automation: the gates are the point.

## Drift check

A scheduled workflow in the home repo compares each `images.json` pin against the registry's current digest for the tracked tag and **fails loudly** on mismatch older than the expected promotion latency. It is a detector for missed dispatches and stuck bump PRs, never a second bump path — there is exactly one way pins change.

## Adoption

Wire promotion when connecting an app repo to a host whose home is elsewhere: the dispatch step in the source repo, the bump + drift workflows in the home repo, and the broker App credentials in both repos' SOPS targets (`ci.broker_app`). Like PR previews, leaving it out is a documented decision in the host repo.
