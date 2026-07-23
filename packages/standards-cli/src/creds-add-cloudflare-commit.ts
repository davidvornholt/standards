import { deleteAccountToken } from './creds-cloudflare';
import {
  type SopsValueChange,
  type SopsWriteResult,
  verifySopsStoredValue,
} from './creds-sops';

export const commitCreatedCloudflareToken = async (input: {
  readonly consumer: string;
  readonly rel: string;
  readonly writes: ReadonlyArray<SopsValueChange>;
  readonly written: SopsWriteResult;
  readonly accountId: string;
  readonly bootstrapToken: string;
  readonly tokenId: string;
  readonly name: string;
}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly problem: string }
> => {
  const stored = input.writes.map((write) => ({
    path: write.path,
    result: verifySopsStoredValue(
      input.consumer,
      input.rel,
      write.path,
      write.value,
    ),
  }));
  if (stored.every(({ result }) => result.ok && result.matches)) {
    return { ok: true };
  }
  const unverifiable = stored.flatMap(({ result }) =>
    result.ok ? [] : [result.problem],
  );
  if (unverifiable.length > 0) {
    const detail = unverifiable.join('; ');
    return {
      ok: false,
      problem: `token ${input.name} was created as ${input.accountId}/${input.tokenId}, but ${input.written.ok ? detail : `${input.written.problem}; ${detail}`}; the token remains active because its stored state is unverifiable`,
    };
  }
  const mismatched = stored.flatMap(({ path, result }) =>
    result.ok && !result.matches ? [path] : [],
  );
  const problem = input.written.ok
    ? `the stored SOPS value at ${mismatched.join(', ')} does not match the replacement`
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
