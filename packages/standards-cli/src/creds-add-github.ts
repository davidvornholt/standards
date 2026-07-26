// `standards creds add github`: place the broker GitHub App's credentials
// into a SOPS target. Durable GitHub tokens cannot be minted via API (PAT
// and OAuth-app creation are UI-only), so the durable secret is the App
// identity itself; workflows mint short-lived installation tokens from it at
// runtime, scoped per repository and permission.

import { inspectDestinations } from './creds-add-preflight';
import { resolveContext } from './creds-dest';
import { verifyGithubAppInstallation } from './creds-github-app-api';
import {
  loadOwnedGithubStore,
  sameGithubApp,
  selectGithubAppForRepo,
} from './creds-github-apps';
import { setSopsValues } from './creds-sops';
import { verifySopsStoredValue } from './creds-sops-value';
import { readBrokerStore, resolveBrokerPath } from './creds-store';
import { withBrokerLock } from './creds-store-lock';

export const runCredsAddGithub = async (
  consumer: string,
  options: { readonly dest: string | undefined },
): Promise<boolean> => {
  const context = await resolveContext(consumer, options.dest);
  if (context === null) {
    return false;
  }
  const appIdPath = `${context.dest.key}.app_id`;
  const privateKeyPath = `${context.dest.key}.private_key`;
  const blocked = await inspectDestinations(consumer, context.rel, [
    appIdPath,
    privateKeyPath,
  ]);
  if (blocked !== null) {
    console.error(`standards creds: ${blocked}`);
    return false;
  }
  const storePath = resolveBrokerPath();
  const loaded = await loadOwnedGithubStore(storePath);
  if (!loaded.ok) {
    console.error(`standards creds: ${loaded.problem}`);
    return false;
  }
  const selected = selectGithubAppForRepo(loaded.value.github, context.repo);
  if (!selected.ok) {
    console.error(`standards creds: ${selected.problem}`);
    return false;
  }
  const installation = await verifyGithubAppInstallation(
    selected.value,
    context.repo,
  );
  if (!installation.ok) {
    console.error(`standards creds: ${installation.problem}`);
    return false;
  }
  const { appId, privateKey, slug } = selected.value;
  let writeResult:
    | { readonly ok: true }
    | { readonly ok: false; readonly problem: string };
  try {
    writeResult = await withBrokerLock(storePath, async () => {
      const current = selectGithubAppForRepo(
        (await readBrokerStore(storePath)).github,
        context.repo,
      );
      if (!current.ok) {
        return current;
      }
      if (!sameGithubApp(current.value, selected.value)) {
        return {
          ok: false,
          problem: `the broker GitHub App for ${selected.value.owner} changed while its installation was being verified; retry so the replacement can be verified`,
        };
      }
      return setSopsValues(consumer, context.rel, [
        { path: appIdPath, value: String(appId) },
        { path: privateKeyPath, value: privateKey },
      ]);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`standards creds: ${message}`);
    return false;
  }
  if (!writeResult.ok) {
    console.error(`standards creds: ${writeResult.problem}`);
    return false;
  }
  const verified = [
    { path: appIdPath, value: String(appId) },
    { path: privateKeyPath, value: privateKey },
  ].map(({ path, value }) => ({
    path,
    result: verifySopsStoredValue(consumer, context.rel, path, value),
  }));
  const unverifiable = verified.find(({ result }) => !result.ok);
  if (unverifiable !== undefined && !unverifiable.result.ok) {
    console.error(`standards creds: ${unverifiable.result.problem}`);
    return false;
  }
  const mismatched = verified
    .filter(({ result }) => result.ok && !result.matches)
    .map(({ path }) => path);
  if (mismatched.length > 0) {
    console.error(
      `standards creds: the stored SOPS value at ${mismatched.join(', ')} does not match the selected GitHub App`,
    );
    return false;
  }
  console.log(
    `standards creds: wrote App ${slug} credentials to ${context.rel} at ${context.dest.key}.{app_id,private_key}`,
  );
  console.log(
    '  workflows mint short-lived installation tokens from these at runtime (actions/create-github-app-token), scoped per repository and permission',
  );
  return true;
};
