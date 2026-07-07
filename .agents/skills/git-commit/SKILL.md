---
name: git-commit
description: Create git commits using Conventional Commits. Use when the user asks to commit changes.
license: MIT
---

# Git commit

Create clean, semantic commits from the actual diff.

## Workflow

1. Inspect repository state:

```bash
git status --short
git diff --staged
git diff
```

2. Split unrelated concerns into separate logical commits.
3. Stage only the files or hunks for the current logical commit.
4. Commit with a concise Conventional Commit message:

```bash
git commit -m "<type>[scope]: <imperative description>"
```

Use a body/footer only when it adds useful context, such as issue references or breaking changes.

## Safety rules

- Never commit secrets, `.env` files, credentials, private keys, or tokens.
- Never update git config.
- Never run destructive commands such as `reset --hard`, `clean -fd`, or force operations without explicit approval.
- Never skip hooks with `--no-verify` unless explicitly asked.
- Do not amend an existing commit unless explicitly asked.
