---
name: screenshots-in-prs
description: Use when opening or editing a pull request for a change to rendered UI. Produces safe, matched visual evidence for reviewers.
---

# Screenshots in PRs

Publish screenshots with `bun standards screenshots publish <files...>` from the repository root. Without `config/screenshots.yaml`, publishing isn't enabled: say so in the pull request and continue without screenshots. Don't fall back to another host.

Published images are public to anyone with the link and kept indefinitely, so use demo data and keep secrets and personal data out of frame.

Capture the states a reviewer needs to judge the change, at a 1280x800 viewport by default, with responsive variants when they help. When the change alters how an existing UI looks, capture a matched pair. Render `Before` from the base revision and `After` from the head, with the same viewport, route, demo data, and UI state. Leave out `Before` only for wholly new UI or when a still image can't show the behavior, and say why in `## Screenshots`.

Give each file a descriptive kebab-case PNG name, which the command turns into the alt text. Put the Markdown it prints in a `## Screenshots` section with a short caption per image, and show each pair side by side, for example in a two-column table.
