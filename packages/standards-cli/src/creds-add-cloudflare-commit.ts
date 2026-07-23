import { deleteAccountToken } from './creds-cloudflare';
import { type SopsWriteResult, verifySopsStoredValue } from './creds-sops';

export const commitCreatedCloudflareToken = async (input: {
  readonly consumer: string;
  readonly rel: string;
  readonly key: string;
  readonly value: string;
  readonly written: SopsWriteResult;
  readonly accountId: string;
  readonly bootstrapToken: string;
  readonly tokenId: string;
  readonly name: string;
}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly problem: string }
> => {
  const stored = verifySopsStoredValue(
    input.consumer,
    input.rel,
    input.key,
    input.value,
  );
  if (stored.ok && stored.matches) {
    return { ok: true };
  }
  if (!stored.ok) {
    return {
      ok: false,
      problem: `token ${input.name} was created as ${input.accountId}/${input.tokenId}, but ${input.written.ok ? stored.problem : `${input.written.problem}; ${stored.problem}`}; the token remains active because its stored state is unverifiable`,
    };
  }
  const problem = input.written.ok
    ? 'the stored SOPS value does not match the replacement'
    : input.written.problem;
  const cleanup = await deleteAccountToken(
    input.accountId,
    input.bootstrapToken,
    input.tokenId,
  );
  return {
    ok: false,
    problem: cleanup.ok
      ? `token ${input.name} was created, but ${problem}; deleted replacement token ${input.tokenId}`
      : `token ${input.name} was created, but ${problem}; cleanup of token ${input.tokenId} also failed: ${cleanup.problem}`,
  };
};
