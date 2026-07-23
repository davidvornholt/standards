// `standards creds add github`: place the broker GitHub App's credentials
// into a SOPS target. Durable GitHub tokens cannot be minted via API (PAT
// and OAuth-app creation are UI-only), so the durable secret is the App
// identity itself; workflows mint short-lived installation tokens from it at
// runtime, scoped per repository and permission.

import { resolveContext } from './creds-dest';
import {
  inspectSopsScalarDestination,
  setSopsValues,
  verifySopsScalarLeaf,
} from './creds-sops';

export const runCredsAddGithub = async (
  consumer: string,
  options: { readonly dest: string | undefined },
): Promise<boolean> => {
  const context = await resolveContext(consumer, options.dest);
  if (context === null) {
    return false;
  }
  if (context.store.github === null) {
    console.error(
      'standards creds: no broker GitHub App configured; run `standards creds login github`',
    );
    return false;
  }
  const { appId, privateKey, slug } = context.store.github;
  const appIdPath = `${context.dest.key}.app_id`;
  const privateKeyPath = `${context.dest.key}.private_key`;
  const preflight = await Promise.all(
    [appIdPath, privateKeyPath].map((path) =>
      inspectSopsScalarDestination(consumer, context.rel, path),
    ),
  );
  const blocked = preflight.find((result) => !result.ok);
  if (blocked !== undefined && !blocked.ok) {
    console.error(`standards creds: ${blocked.problem}`);
    return false;
  }
  const written = setSopsValues(consumer, context.rel, [
    { path: appIdPath, value: String(appId) },
    { path: privateKeyPath, value: privateKey },
  ]);
  if (!written.ok) {
    console.error(`standards creds: ${written.problem}`);
    return false;
  }
  const verified = await Promise.all(
    [appIdPath, privateKeyPath].map((path) =>
      verifySopsScalarLeaf(consumer, context.rel, path),
    ),
  );
  const failedVerification = verified.find((result) => !result.ok);
  if (failedVerification !== undefined && !failedVerification.ok) {
    console.error(`standards creds: ${failedVerification.problem}`);
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
