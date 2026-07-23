// Deterministic provider-side token names are the reconciliation key between
// a repository's SOPS key structure and the tokens the broker minted for it:
// `standards/<owner>/<repo>/<sops-target>/<dotted.key>`. No separate ledger
// exists — the SOPS file (plaintext key structure) and the provider token
// list, joined by this scheme, are the two sources of truth.

const NAME_PREFIX = 'standards';

// One broker identity credential per provider — the GitHub App and each
// account's Cloudflare bootstrap token — shares this name. It contains no
// slash, so it can never fall inside the minted namespace below.
export const BROKER_IDENTITY_NAME = 'standards-broker';

// The whole `standards/` prefix is reserved for minted tokens, deliberately
// broader than the names reconciliation parses today: login is the only
// cheap place to enforce the boundary, and a name that does not parse under
// the current scheme could become parseable if the scheme ever widens.
export const isInMintedNamespace = (name: string): boolean =>
  name.startsWith(`${NAME_PREFIX}/`);

export type BrokeredTokenRef = {
  readonly repo: string;
  readonly target: string;
  readonly key: string;
};

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SAFE_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export const assertTokenRef = ({
  repo,
  target,
  key,
}: BrokeredTokenRef): void => {
  if (!SAFE_REPO.test(repo)) {
    throw new Error(`invalid repository for token naming: ${repo}`);
  }
  if (!SAFE_SEGMENT.test(target)) {
    throw new Error(`invalid secrets target for token naming: ${target}`);
  }
  for (const segment of key.split('.')) {
    if (!SAFE_SEGMENT.test(segment)) {
      throw new Error(`invalid secret key for token naming: ${key}`);
    }
  }
};

export const tokenNameOf = (ref: BrokeredTokenRef): string => {
  assertTokenRef(ref);
  return `${NAME_PREFIX}/${ref.repo}/${ref.target}/${ref.key}`;
};

export const repoTokenPrefix = (repo: string): string =>
  `${NAME_PREFIX}/${repo}/`;

// Only names this broker minted for this repository parse; every other token
// (hand-made, other repos, other tools) returns null and is never touched.
export const parseTokenName = (
  name: string,
  repo: string,
): BrokeredTokenRef | null => {
  const prefix = repoTokenPrefix(repo);
  if (!name.startsWith(prefix)) {
    return null;
  }
  const rest = name.slice(prefix.length);
  const separator = rest.indexOf('/');
  if (separator <= 0 || separator === rest.length - 1) {
    return null;
  }
  const ref = {
    repo,
    target: rest.slice(0, separator),
    key: rest.slice(separator + 1),
  };
  try {
    assertTokenRef(ref);
  } catch {
    return null;
  }
  return ref;
};
