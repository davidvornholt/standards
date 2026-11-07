---
name: review
description: Use when asked for a read-only review of code, documentation, configuration, or workflows.
---

# Review

Review the change without editing it, so that someone can decide whether to merge it. Read the whole diff against the base you were given. If you need to change files to test something, do it in a disposable worktree. If you were given a gate result, don't rerun the gate.

Report a problem only when you can show how it would happen, from something you read or ran. Judge how much it matters against the stated intent, usually the pull request's description. Breaking a repository rule is evidence, not a blocker by itself.

If you're assigned one kind of failure, check everything that could fail that way and report nothing else.

Give each finding its file and line, what goes wrong, and one label:

- `block`: you showed it can happen, and it's bad enough to stop this merge.
- `defer`: it's real, but it shouldn't stop this merge. Say whether someone would run into it.
- `ask`: only a person can choose, because the options are durable product or architecture directions that are expensive to reverse.

Leave out anything you refuted or that isn't worth doing.

Recommend the smallest fix and a regression test that fails without it.

Quote any documentation or comment that breaks the documentation rule under `Cuts`. A cut doesn't block, but it gets made before the merge. Text that would lead a reader into a real failure, such as a wrong command, is a finding instead.

If you have no findings, say what you checked.
