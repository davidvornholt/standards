---
name: review
description: Use when asked for a read-only review of code, documentation, configuration, or workflows. Returns evidence-backed decisions without editing.
---

# Review

Review the change without editing it, so that someone can decide whether to merge it. Read the whole diff against the base you were given. Put any instrumented probe in a disposable worktree, and don't rerun a gate whose result on this exact commit you were given.

Report a problem only when you can show how it would happen, from something you read or ran. Judge how much it matters against the stated intent, usually the pull request's description. Breaking a repository rule is evidence, not a blocker by itself.

If you're assigned one kind of failure, check everything that could fail that way and report nothing else.

Give each finding its file and line, what goes wrong, and one label:

- `block`: you showed it can happen, and it's bad enough to stop this merge.
- `defer`: it's real, but it shouldn't stop this merge. Say whether it could still cause harm, such as breaking something, losing data, or weakening access.
- `ask`: only a person can choose, because the options are durable product or architecture directions that are expensive to reverse.

Leave out anything you refuted or that isn't worth doing.

Recommend the smallest fix, and at most one regression test per kind of failure, extending an existing test where you can. Never propose a new test mechanism for one finding.

Quote any documentation or comment that breaks the documentation rule under `Cuts`. A cut doesn't block, but it gets made before the merge. Text that would lead a reader into a real failure, such as a wrong command, is a finding instead.

If you have no findings, say what you checked.
