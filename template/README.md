# Project

> Built on [davidvornholt/standards](https://github.com/davidvornholt/standards).

Replace this with your project's README.

## Standards sync policy

`sync-standards.local.json` is checked-in, repository-owned configuration for standards updates. Its `ref` accepts `refs/heads/<branch>`, `refs/tags/<tag>`, or a full commit SHA; `scheduledSync: false` skips scheduled GitHub Actions syncs while manual and local syncs still run. Existing repositories without the file default to `refs/heads/main` and scheduled sync enabled.
