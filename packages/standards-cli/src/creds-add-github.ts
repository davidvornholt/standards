// `standards creds add github`: place the broker GitHub App's credentials
// into a SOPS target. Durable GitHub tokens cannot be minted via API (PAT
// and OAuth-app creation are UI-only), so the durable secret is the App
// identity itself; workflows mint short-lived installation tokens from it at
// runtime, scoped per repository and permission.

import { resolveContext } from './creds-dest';
import { setSopsValue } from './creds-sops';

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
  const appIdWrite = setSopsValue(
    consumer,
    context.rel,
    `${context.dest.key}.app_id`,
    String(appId),
  );
  const keyWrite = appIdWrite.ok
    ? setSopsValue(
        consumer,
        context.rel,
        `${context.dest.key}.private_key`,
        privateKey,
      )
    : appIdWrite;
  if (!keyWrite.ok) {
    console.error(`standards creds: ${keyWrite.problem}`);
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
