import { expect, it } from 'bun:test';
import { file } from './release-runtime';

const releaseDocumentation = await file(
  `${import.meta.dir}/../README.md`,
).text();

it('documents the GitHub-provided OIDC publication environment', () => {
  expect(releaseDocumentation).toContain(
    '**`ACTIONS_ID_TOKEN_REQUEST_TOKEN`** (required secret for npm provenance publication; no local default)',
  );
  expect(releaseDocumentation).toContain('short-lived bearer credential');
  expect(releaseDocumentation).toContain(
    '**`ACTIONS_ID_TOKEN_REQUEST_URL`** (required non-secret configuration for npm provenance publication; no local default)',
  );
  expect(releaseDocumentation).toContain(
    'GitHub Actions supplies the OIDC request endpoint',
  );
  expect(releaseDocumentation).toContain(
    'does not authorize a request without `ACTIONS_ID_TOKEN_REQUEST_TOKEN`',
  );
});
