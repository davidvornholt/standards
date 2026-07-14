# Standards release tooling

This private workspace owns the repository-only npm and GitHub release boundary. It is not part of the published `@davidvornholt/standards` package.

Release packing treats `packages/standards-cli` as caller-owned and read-only. Read-only namespace inspection refuses any pre-existing `SOURCE_COMMIT` entry, including non-regular files. The unmodified source package is packed normally, then the release boundary accepts only Bun's regular-file USTAR dialect: exact magic and version, valid checksums and field terminators, zero header/content padding, and exactly two terminal zero blocks. It deterministically rewrites `package/package.json` so `gitHead` equals the tested commit before appending the matching `package/SOURCE_COMMIT`; every other public entry and its semantics remain unchanged. The completed artifact is re-read through the same identity verifier used for existing npm artifacts.

Every authorized successful main-branch quality run inspects npm after the cheap manifest checks and frozen install; no first-parent comparison gates inspection. If the current version is absent, the tested commit is packed and published. If it exists, the registry tarball is downloaded and its SRI, strict tar structure, package name and version, `gitHead`, and `SOURCE_COMMIT` are verified before its source commit is used for GitHub tag and Release reconciliation. The source commit must be an ancestor of the current tested commit. This makes failed or coalesced bump runs and npm-success/GitHub-failure retries recoverable while legacy, mismatched, or malformed artifacts fail closed.

## Configuration

- **`GITHUB_REPOSITORY`** (required by GitHub release commands) — repository identifier in `owner/repository` form. GitHub Actions supplies it automatically.
- **`GH_TOKEN` / `GITHUB_TOKEN`** (one required by GitHub release commands) — GitHub API token used to inspect and reconcile tags and releases. The first non-empty value is used, preferring `GH_TOKEN`; the release workflow exposes its GitHub-provided token as `GH_TOKEN`.
