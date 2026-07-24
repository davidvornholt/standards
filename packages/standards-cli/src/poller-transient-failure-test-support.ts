const HTTP_INTERNAL_SERVER_ERROR = 500;

export const failGitHubRequestOnce = (
  method: string,
  pathSuffix: string,
): void => {
  const fallback = globalThis.fetch;
  let failed = false;
  globalThis.fetch = ((
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (
      !failed &&
      (init?.method ?? 'GET') === method &&
      path.endsWith(pathSuffix)
    ) {
      failed = true;
      return Promise.resolve(
        new Response(JSON.stringify({ message: 'temporary GitHub failure' }), {
          status: HTTP_INTERNAL_SERVER_ERROR,
        }),
      );
    }
    return fallback(input, init);
  }) as typeof fetch;
};
