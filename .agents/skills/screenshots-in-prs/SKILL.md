---
name: screenshots-in-prs
description: Must be used when opening or updating a pull request that changes rendered UI. Covers capturing screenshots, publishing them, and embedding them in the PR description.
---

# Screenshots in PRs

- If `config/screenshots.yaml` is absent, state in the PR that screenshot publishing is not enabled and continue without screenshots. Do not use another host.
- Capture the states needed to review the change. Include before-and-after or responsive variants when they clarify it.
- Default to a 1280x800 viewport. Use descriptive kebab-case PNG filenames; the filename becomes the alt text.
- Published URLs are public and permanent. Use demo data and exclude secrets and personal data.
- From the repository root, run `bun standards screenshots publish <files...>`.
- Put the printed Markdown in a `## Screenshots` section with short captions. Use a two-column table when comparing images side by side helps the review.
