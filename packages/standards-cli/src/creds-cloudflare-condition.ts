import { isRecord } from './github-settings-parse';

export type TokenCondition = {
  readonly requestIp: {
    readonly in?: ReadonlyArray<string>;
    readonly notIn?: ReadonlyArray<string>;
  };
};

export type DecodedTokenCondition =
  | { readonly supported: true; readonly value: TokenCondition | null }
  | { readonly supported: false };

const stringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

export const decodeTokenCondition = (raw: unknown): DecodedTokenCondition => {
  if (raw === undefined || raw === null) {
    return { supported: true, value: null };
  }
  if (!isRecord(raw) || Object.keys(raw).some((key) => key !== 'request_ip')) {
    return { supported: false };
  }
  const requestIp = raw.request_ip;
  if (
    !isRecord(requestIp) ||
    Object.keys(requestIp).some((key) => key !== 'in' && key !== 'not_in') ||
    ('in' in requestIp && !stringArray(requestIp.in)) ||
    ('not_in' in requestIp && !stringArray(requestIp.not_in))
  ) {
    return { supported: false };
  }
  return {
    supported: true,
    value: {
      requestIp: {
        ...('in' in requestIp
          ? { in: requestIp.in as ReadonlyArray<string> }
          : {}),
        ...('not_in' in requestIp
          ? { notIn: requestIp.not_in as ReadonlyArray<string> }
          : {}),
      },
    },
  };
};

export const encodeTokenCondition = (
  condition: TokenCondition,
): Readonly<Record<string, unknown>> => ({
  // biome-ignore lint/style/useNamingConvention: Cloudflare's condition wire field is snake_case.
  request_ip: {
    ...(condition.requestIp.in === undefined
      ? {}
      : { in: condition.requestIp.in }),
    ...(condition.requestIp.notIn === undefined
      ? {}
      : {
          // biome-ignore lint/style/useNamingConvention: Cloudflare's condition wire field is snake_case.
          not_in: condition.requestIp.notIn,
        }),
  },
});
