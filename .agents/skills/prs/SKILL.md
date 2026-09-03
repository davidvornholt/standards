---
name: prs
description: Use when opening a pull request or changing its title or description. Produces a decision-ready, reproducible change record.
---

# Pull requests

One pull request delivers one coherent outcome, including its required migrations, tests, documentation, and supporting changes. If the changes contain independent outcomes, propose separate pull requests.

## Title

Pull requests squash into main. Use a Conventional Commit title (`<type>(scope): <imperative description>`); the title and description become the commit subject and body.

## Description

Write for a decider with no background knowledge who has not read the code. Open with exactly two short paragraphs and no heading or summary before them:

```md
**Before.** Describe the existing behavior, who or what it affects, and its concrete cost or risk.

**Now.** Describe the resulting behavior and how it resolves that problem.
```

For a new capability, `Before` names the missing ability, current workaround, cost, or risk, not merely that the feature did not exist.

## Additional sections

Add only what the change needs.

- `## Implementation` contains details needed to review the implementation.
- `## Breaking change` names affected consumers and their required migration.
- For rendered UI changes, use `screenshots-in-prs`; it owns `## Screenshots`.

Do not repeat information between sections.

## Verification

Always include `## Verification` with `### Completed checks`, reporting exact results, including partial runs or failures.

Add `### Check it yourself` only when a reviewer can verify behavior interactively or visually. Give the exact `gh pr checkout <number-or-branch>` command, the shortest steps, and the expected result.
