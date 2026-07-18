import { listAllPages } from './github-paginate';
import { isRecord } from './github-settings-parse';

export const repositoryIssueWithMarkerExists = async (
  token: string | null,
  repo: string,
  marker: string,
): Promise<boolean> => {
  const items = await listAllPages(
    token,
    `/repos/${repo}/issues?state=all`,
    `list ${repo} issues for publication marker`,
  );
  return items.some(
    (item) =>
      isRecord(item) &&
      typeof item.body === 'string' &&
      item.body.includes(marker),
  );
};
