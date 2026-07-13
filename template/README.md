# Project

> Built on [davidvornholt/standards](https://github.com/davidvornholt/standards).

Replace this with your project's README.

## Standards sync policy

`sync-standards.local.json` is checked-in, repository-owned configuration for standards updates. Its `ref` accepts `refs/heads/<branch>`, `refs/tags/<tag>`, or a full commit SHA; `scheduledSync: false` skips scheduled GitHub Actions syncs while manual and local syncs still run. The weekly cadence remains canonical. Existing repositories without the file default to `refs/heads/main` and scheduled sync enabled.

Non-default policy requires `@davidvornholt/standards` >=0.5.0. Existing consumers must first upgrade the bucket-2 dependency—for 0.5.0, run `bun add --dev --exact @davidvornholt/standards@0.5.0`; standards sync cannot update the consumer-owned `package.json`.
