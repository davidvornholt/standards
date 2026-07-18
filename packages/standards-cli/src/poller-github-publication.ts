import { listAllPages } from './github-paginate';
import { isRecord } from './github-settings-parse';

export const repositoryIssueMarkerAuthors = async (
  token: string | null,
  repo: string,
  marker: string,
): Promise<ReadonlyArray<string>> => {
  const items = await listAllPages(
    token,
    `/repos/${repo}/issues?state=all`,
    `list ${repo} issues for publication marker`,
  );
  return items.flatMap((item) =>
    isRecord(item) &&
    typeof item.body === 'string' &&
    item.body.includes(marker) &&
    isRecord(item.user) &&
    typeof item.user.login === 'string'
      ? [item.user.login]
      : [],
  );
};
