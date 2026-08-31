---
name: screenshots-in-prs
description: Must be used when opening or updating a pull request that changes rendered UI, including pages, components, styles, layout, themes, or visual states. Covers capturing screenshots, publishing them with `bun standards screenshots publish`, and embedding them in the PR description.
---

# Screenshots in PRs

A PR that changes rendered UI must show the result. Reviewers decide from the description; a screenshot answers "what does this look like now" without checking out the branch.

## Enablement

- Screenshot publishing is opt-in per repository. It is enabled when the tracked `config/screenshots.yaml` exists; run `bun standards screenshots help` for the contract.
- If the file is absent, do not invent another upload path (no throwaway branches, no third-party image hosts). State in the PR description that screenshot publishing is not enabled in this repository and move on.

## Capture

- Run the app and capture real rendered output with the browser tooling available to you (Playwright, agent browser tools). Do not mock up or hand-draw UI.
- Capture every meaningfully changed state: the default view, plus error, empty, loading, or open-overlay states when the change affects them. For a modified existing view, capture before and after.
- Use a consistent desktop viewport (1280×800 unless the change targets another size) and add a mobile-width capture when the change is responsive.
- Save as PNG with a short kebab-case name describing the view and state, such as `settings-empty-state.png`. The filename becomes both the public URL segment and the image's alt text, so it must be descriptive and URL-safe.
- Published URLs are public to anyone holding the link and are kept indefinitely. Never capture real secrets, tokens, or personal data; use seeded demo data.

## Publish and embed

- Publish all captures in one command from the repo root: `bun standards screenshots publish <files...>`. It uploads each file to the configured public bucket at a content-addressed key (`screenshots/<sha256>/<name>`) and prints one PR-ready markdown line per file, in input order. Publishing needs SOPS decryption access; if the credential pair is missing, the command prints the exact `creds` invocation that mints it.
- Put the printed lines in a `## Screenshots` section of the PR description, each with a short caption naming the view and state. Pair before/after captures side by side in a two-column table.
- Published objects are immutable: republishing identical bytes yields the same URL, and a revised capture yields a new URL. After changing the UI again, capture and publish fresh screenshots and replace the stale links in the PR description.
