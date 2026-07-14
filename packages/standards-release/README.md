# Standards release tooling

This private workspace owns the repository-only npm and GitHub release boundary. It is not part of the published `@davidvornholt/standards` package.

Release packing treats `packages/standards-cli` as caller-owned and read-only. Read-only namespace inspection refuses any pre-existing `SOURCE_COMMIT` entry, including non-regular files. The unmodified source package is packed normally, then the release boundary deterministically rewrites the tarball in memory to append only `package/SOURCE_COMMIT`; the package manifest remains the authority for every other public entry. The completed artifact is verified before publication, and read, tar, compression, write, and identity failures remain tagged release errors. Matching npm SRI therefore binds an artifact without `gitHead` metadata to the tested commit; legacy unmarked artifacts fail closed.

## Configuration

- **`GITHUB_REPOSITORY`** (required by GitHub release commands) — repository identifier in `owner/repository` form. GitHub Actions supplies it automatically.
- **`GH_TOKEN` / `GITHUB_TOKEN`** (one required by GitHub release commands) — GitHub API token used to inspect and reconcile tags and releases. The first non-empty value is used, preferring `GH_TOKEN`; the release workflow exposes its GitHub-provided token as `GH_TOKEN`.
