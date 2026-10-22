---
name: issues
description: Use when opening an issue or changing its title or description. Produces an actionable problem record for a decider with no project context.
---

# Issues

Whoever decides on an issue or picks it up, often an agent, reads it later without your context. Give it a plain-language title that names the problem or the desired outcome, and open the description with exactly these two paragraphs:

```md
**Problem.** The current behavior or missing ability, who or what it affects, and its concrete cost or risk.

**Outcome.** The observable result or decision that closes the issue.
```

The outcome says when the issue is done, not how. Name an implementation only when one is already decided, because whoever picks up the issue will treat a suggested approach as settled.

Put the support for the problem under `## Evidence`: observations, reproduction steps, measurements, code references, or sources, without restating the opening.

Add `## Decision` only when work can't start until someone makes a choice.
