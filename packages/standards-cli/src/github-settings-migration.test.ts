import { describe, expect, it } from 'bun:test';
import { loadGithubSettings } from './github-settings';

const ALLOW_AUTO_MERGE = 'allow_auto_merge';
const ALLOW_MERGE_COMMIT = 'allow_merge_commit';
const ALLOW_REBASE_MERGE = 'allow_rebase_merge';
const ALLOW_SQUASH_MERGE = 'allow_squash_merge';
const mergePolicy = {
  [ALLOW_MERGE_COMMIT]: false,
  [ALLOW_REBASE_MERGE]: false,
  [ALLOW_SQUASH_MERGE]: true,
};
const oldCanonical = JSON.stringify({
  repository: { [ALLOW_AUTO_MERGE]: true },
  rulesets: [],
});
const newCanonical = JSON.stringify({
  repository: { [ALLOW_AUTO_MERGE]: true, ...mergePolicy },
  rulesets: [],
});
const oldLocal = JSON.stringify({
  repository: mergePolicy,
  rulesets: [],
});
const cleanedLocal = JSON.stringify({ repository: {}, rulesets: [] });

describe('GitHub settings merge-policy migration', () => {
  it('moves formerly local merge policy to canonical ownership', () => {
    expect(loadGithubSettings(oldCanonical, oldLocal).problems).toEqual([]);
    expect(loadGithubSettings(newCanonical, oldLocal).problems).toEqual([
      '.github/settings.local.json repository."allow_merge_commit" would override a canonical value; canonical settings are read-only',
      '.github/settings.local.json repository."allow_rebase_merge" would override a canonical value; canonical settings are read-only',
      '.github/settings.local.json repository."allow_squash_merge" would override a canonical value; canonical settings are read-only',
    ]);
    expect(loadGithubSettings(newCanonical, cleanedLocal)).toMatchObject({
      merged: {
        repository: { [ALLOW_AUTO_MERGE]: true, ...mergePolicy },
      },
      problems: [],
    });
  });
});
