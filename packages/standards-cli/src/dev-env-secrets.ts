import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { decryptSopsJson, type SopsJsonResult } from './sops-exec';

export const DEV_SECRETS_FILE = 'secrets/dev.yaml';

export type DevSecretsResult = SopsJsonResult;

export const readDevSecrets = (consumer: string): DevSecretsResult => {
  if (!existsSync(join(consumer, DEV_SECRETS_FILE))) {
    return {
      ok: false,
      problem: `${DEV_SECRETS_FILE} not found; create it with \`just secrets edit dev\``,
    };
  }
  return decryptSopsJson(consumer, DEV_SECRETS_FILE);
};
