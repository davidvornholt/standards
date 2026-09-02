---
name: screenshots-in-prs
description: Use when opening or editing a pull request for a change to rendered UI. Produces safe, matched visual evidence for reviewers.
---

# Screenshots in PRs

- If `config/screenshots.yaml` is absent, state in the PR that screenshot publishing is not enabled and continue without screenshots. Do not use another host.
- Capture the states needed to review the change. Include responsive variants when they clarify it.
- For every change to an existing UI's visible presentation, capture matched `Before` and `After` screenshots. Render `Before` from the PR's base revision and `After` from its head with the same viewport, route, demo data, and UI state, then present the pair side by side. Omit `Before` only for wholly new UI or when a still image cannot show the changed behavior, and state why in `## Screenshots`.
- Default to a 1280x800 viewport. Use descriptive kebab-case PNG filenames; the filename becomes the alt text.
- Published URLs are public and permanent. Use demo data and exclude secrets and personal data.
- From the repository root, run `bun standards screenshots publish <files...>`.
- Put the printed Markdown in a `## Screenshots` section with short captions. Use a two-column table when comparing images side by side helps the review.
