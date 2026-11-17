// Keeps one open issue per repository whose brokered tokens are due, in the
// repository the watcher runs in. The watcher's workflow token can't write to
// other owners' repositories, and the issues name private repositories and
// their secret keys, so they live in one private repository rather than in
// each consumer. The issue closes itself once nothing in its repository is due.

import { RENEW_WITHIN_DAYS } from './creds-cloudflare-expiry';
import type { DueToken } from './creds-watch-due';
import {
  type ApiResponse,
  apiError,
  HTTP_CREATED,
  HTTP_OK,
  request,
} from './github-api';
import { isRecord } from './github-settings-parse';

export const WATCH_LABEL = 'brokered-token-expiry';
const HTTP_UNPROCESSABLE = 422;
const PAGE_SIZE = 100;
const MARKER = /^<!-- standards-creds-watch: (?<repo>[^ ]+) -->$/mu;

const marker = (repo: string): string =>
  `<!-- standards-creds-watch: ${repo} -->`;

const day = (iso: string): string => iso.slice(0, 'YYYY-MM-DD'.length);

export const renderIssue = (
  repo: string,
  due: ReadonlyArray<DueToken>,
): { readonly title: string; readonly body: string } => {
  const [first] = due;
  const firstDay = day(first?.expiresOn ?? '');
  const title = first?.expired
    ? `Brokered Cloudflare tokens of ${repo} expired on ${firstDay}`
    : `Brokered Cloudflare tokens of ${repo} expire on ${firstDay}`;
  const count =
    due.length === 1
      ? 'One brokered Cloudflare token'
      : `${due.length} brokered Cloudflare tokens`;
  const verb =
    due.length === 1 ? 'has expired or expires' : 'have expired or expire';
  const body = [
    marker(repo),
    '',
    `**Problem.** ${count} of ${repo} ${verb} within ${RENEW_WITHIN_DAYS} days; the earliest expiry is ${firstDay}. Whatever uses an expired token, such as a deploy, CI, or a running app, loses access to Cloudflare, and the Cloudflare dashboard hides expired tokens rather than showing them as expired.`,
    '',
    `**Outcome.** Every token below is renewed, so none of ${repo}'s brokered tokens expires within ${RENEW_WITHIN_DAYS} days. The next \`standards creds watch\` run then closes this issue.`,
    '',
    '## Evidence',
    '',
    ...due.map(
      (token) =>
        `- \`${token.name}\` ${token.expired ? 'expired' : 'expires'} ${token.expiresOn} (account \`${token.accountId}\`, token ID \`${token.tokenId}\`).`,
    ),
    '',
    '## How to renew',
    '',
    `On a machine with the broker store (\`standards creds status\` shows it), in a checkout of ${repo} on a new branch from an up-to-date \`main\`, run:`,
    '',
    '```sh',
    'bunx @davidvornholt/standards@latest creds apply',
    '```',
    '',
    'It renews each token above for at least a year and writes the replacement into its SOPS file, or revokes a token whose SOPS key is gone. Commit the changed SOPS files, open a pull request, merge it, and deploy. Each old token keeps working until its current expiry under a name ending in `(superseded)`, so a running app keeps its access until the deploy; deploy before then. If `creds apply` stops on same-name duplicate tokens, which an interrupted renewal leaves behind, first deploy the stored token and confirm the app works with it, then follow the `standards creds revoke` command it prints for the leftover token and run `creds apply` again.',
    '',
  ].join('\n');
  return { title, body };
};

type OpenIssue = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly repo: string;
};

const ensureLabel = async (
  token: string,
  home: string,
): Promise<string | null> => {
  const response = await request(token, 'POST', `/repos/${home}/labels`, {
    name: WATCH_LABEL,
    color: 'B60205',
    description: `Brokered Cloudflare tokens that expire within ${RENEW_WITHIN_DAYS} days`,
  });
  // 422 means the label already exists.
  return response.status === HTTP_CREATED ||
    response.status === HTTP_UNPROCESSABLE
    ? null
    : apiError(`create label ${WATCH_LABEL} in ${home}`, response);
};

const listOpenIssues = async (
  token: string,
  home: string,
): Promise<
  | { readonly ok: true; readonly issues: ReadonlyArray<OpenIssue> }
  | { readonly ok: false; readonly problem: string }
> => {
  const response = await request(
    token,
    'GET',
    `/repos/${home}/issues?state=open&labels=${WATCH_LABEL}&per_page=${PAGE_SIZE}`,
  );
  if (response.status !== HTTP_OK || !Array.isArray(response.body)) {
    return {
      ok: false,
      problem: apiError(`list open ${WATCH_LABEL} issues in ${home}`, response),
    };
  }
  // One page holds an issue per repository with due tokens; a full page
  // could hide one, and closing decisions need the whole list.
  if (response.body.length >= PAGE_SIZE) {
    return {
      ok: false,
      problem: `${home} has ${PAGE_SIZE} or more open ${WATCH_LABEL} issues; close the stale ones`,
    };
  }
  const issues = response.body.flatMap((raw: unknown): Array<OpenIssue> => {
    if (
      !isRecord(raw) ||
      raw.pull_request !== undefined ||
      typeof raw.number !== 'number' ||
      typeof raw.title !== 'string'
    ) {
      return [];
    }
    const body = typeof raw.body === 'string' ? raw.body : '';
    const repo = body.match(MARKER)?.groups?.repo;
    return repo === undefined
      ? []
      : [{ number: raw.number, title: raw.title, body, repo }];
  });
  return { ok: true, issues };
};

const expectStatus = (
  response: ApiResponse,
  status: number,
  context: string,
): string | null =>
  response.status === status ? null : apiError(context, response);

const upsert = async (
  token: string,
  home: string,
  existing: OpenIssue | undefined,
  rendered: { readonly title: string; readonly body: string },
): Promise<{ readonly problem: string | null; readonly line: string }> => {
  if (existing === undefined) {
    const response = await request(token, 'POST', `/repos/${home}/issues`, {
      ...rendered,
      labels: [WATCH_LABEL],
    });
    const number =
      isRecord(response.body) && typeof response.body.number === 'number'
        ? response.body.number
        : '?';
    return {
      problem: expectStatus(response, HTTP_CREATED, `open issue in ${home}`),
      line: `opened ${home}#${number}: ${rendered.title}`,
    };
  }
  if (
    existing.title === rendered.title &&
    existing.body.trimEnd() === rendered.body.trimEnd()
  ) {
    return { problem: null, line: `${home}#${existing.number} is current` };
  }
  const response = await request(
    token,
    'PATCH',
    `/repos/${home}/issues/${existing.number}`,
    rendered,
  );
  return {
    problem: expectStatus(
      response,
      HTTP_OK,
      `update ${home}#${existing.number}`,
    ),
    line: `updated ${home}#${existing.number}: ${rendered.title}`,
  };
};

const close = async (
  token: string,
  home: string,
  issue: OpenIssue,
): Promise<{ readonly problem: string | null; readonly line: string }> => {
  const comment = await request(
    token,
    'POST',
    `/repos/${home}/issues/${issue.number}/comments`,
    {
      body: `No brokered Cloudflare token of ${issue.repo} expires within ${RENEW_WITHIN_DAYS} days any more.`,
    },
  );
  const commented = expectStatus(
    comment,
    HTTP_CREATED,
    `comment on ${home}#${issue.number}`,
  );
  if (commented !== null) {
    return { problem: commented, line: '' };
  }
  const response = await request(
    token,
    'PATCH',
    `/repos/${home}/issues/${issue.number}`,
    // biome-ignore lint/style/useNamingConvention: GitHub's REST field.
    { state: 'closed', state_reason: 'completed' },
  );
  return {
    problem: expectStatus(response, HTTP_OK, `close ${home}#${issue.number}`),
    line: `closed ${home}#${issue.number}`,
  };
};

// `complete` is false when some account could not be listed or some token's
// expiry could not be read: a repository missing from `byRepo` may then just
// be unseen, so nothing is closed.
export const syncExpiryIssues = async (input: {
  readonly token: string;
  readonly home: string;
  readonly byRepo: ReadonlyMap<string, ReadonlyArray<DueToken>>;
  readonly complete: boolean;
}): Promise<{
  readonly problems: ReadonlyArray<string>;
  readonly lines: ReadonlyArray<string>;
}> => {
  const { token, home, byRepo, complete } = input;
  const labelProblem = await ensureLabel(token, home);
  if (labelProblem !== null) {
    return { problems: [labelProblem], lines: [] };
  }
  const listed = await listOpenIssues(token, home);
  if (!listed.ok) {
    return { problems: [listed.problem], lines: [] };
  }
  const operations = [
    ...[...byRepo].map(([repo, due]) =>
      upsert(
        token,
        home,
        listed.issues.find((issue) => issue.repo === repo),
        renderIssue(repo, due),
      ),
    ),
    ...(complete
      ? listed.issues
          .filter((issue) => !byRepo.has(issue.repo))
          .map((issue) => close(token, home, issue))
      : []),
  ];
  const results = await Promise.all(operations);
  return {
    problems: results.flatMap(({ problem }) =>
      problem === null ? [] : [problem],
    ),
    lines: results.flatMap(({ problem, line }) =>
      problem === null ? [line] : [],
    ),
  };
};
