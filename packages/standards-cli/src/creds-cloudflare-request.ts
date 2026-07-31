const API_ROOT = 'https://api.cloudflare.com/client/v4';

type CloudflareRequestResult =
  | { readonly ok: true; readonly value: Response }
  | { readonly ok: false; readonly problem: string };

export const requestCloudflare = async (
  token: string,
  method: string,
  path: string,
  body: unknown,
): Promise<CloudflareRequestResult> => {
  try {
    const response = await fetch(`${API_ROOT}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { ok: true, value: response };
  } catch (error) {
    return {
      ok: false,
      problem: `${method} ${path}: request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
};
