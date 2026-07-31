import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runSops } from './sops-exec';

export const DEV_SECRETS_FILE = 'secrets/dev.yaml';

const SOPS_ARGS = ['--decrypt', '--output-type', 'json', DEV_SECRETS_FILE];

export type DevSecretsResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly problem: string };

// sops emits JSON here so the CLI never parses the encrypted YAML itself.
export const readDevSecrets = (consumer: string): DevSecretsResult => {
  if (!existsSync(join(consumer, DEV_SECRETS_FILE))) {
    return {
      ok: false,
      problem: `${DEV_SECRETS_FILE} not found; create it with \`just secrets edit dev\``,
    };
  }
  const result = runSops(SOPS_ARGS, consumer);
  if (result.status !== 0) {
    const detail = result.errorMessage ?? result.stderr.trim();
    return {
      ok: false,
      problem: detail
        ? `could not decrypt ${DEV_SECRETS_FILE}: ${detail}`
        : `could not decrypt ${DEV_SECRETS_FILE}`,
    };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) as unknown };
  } catch (error) {
    return {
      ok: false,
      problem: `could not parse decrypted ${DEV_SECRETS_FILE} as JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
};
